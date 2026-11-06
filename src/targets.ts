import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionError } from './executor.js';
import type { z } from 'zod';
import type { targetQuerySchema } from './schema.js';
import { droppedItem } from './entity-observation.js';

type Point = { x: number; y: number; z: number };
export function entityKind(entity: Bot['entity']): 'player' | 'item' | 'mob' | 'other' {
  if (entity.username || entity.type === 'player') return 'player';
  if (droppedItem(entity)) return 'item';
  // Modern minecraft-data splits mobs into these types; armor stands remain "living"/other.
  return ['mob','animal','ambient','hostile','water_creature','passive'].includes(entity.type) ? 'mob' : 'other';
}
export type ObservedTarget = {
  ref: string; kind: 'block' | 'entity' | 'placement' | 'position'; name: string; position: Point;
  droppedItem?: ReturnType<typeof droppedItem>;
  entityKind?: ReturnType<typeof entityKind>;
  observedAt: number; expiresAt: number;
};
type Entry = ObservedTarget & { dimension: string; version: string; stateId?: number;
  entityId?: number; uuid?: string; entityIdentity?: Bot['entity']; support?: Point; supportState?: number };
const point = (p: Point): Point => ({ x: p.x, y: p.y, z: p.z });
const empty = (name: string) => ['air', 'cave_air', 'void_air'].includes(name);
const solidSupport = (block: NonNullable<ReturnType<Bot['blockAt']>>) => block.boundingBox === 'block'
  && block.shapes?.some(shape => shape.length === 6 && shape.every((value, index) => value === (index < 3 ? 0 : 1)));

/** Opaque, bounded, per-Bot observations. Resolution always reads the world again. */
export class TargetRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly bot: Bot, private readonly now = Date.now, private readonly ttlMs = 30_000) {}
  clear() { this.entries.clear(); }
  private inRange(position: Point, radius: number) {
    return this.bot.entity.position.distanceTo(new Vec3(position.x, position.y, position.z)) <= radius;
  }
  private add(value: Omit<Entry, 'ref' | 'observedAt' | 'expiresAt' | 'dimension' | 'version'>): ObservedTarget {
    const now = this.now();
    for (const [ref, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(ref);
    // Repeated snapshots do not evict still-valid targets or extend an old token's lifetime.
    const existing = [...this.entries.values()].find(e => e.kind === value.kind
      && e.dimension === this.bot.game.dimension && e.version === this.bot.version
      && (value.kind === 'entity' ? e.entityIdentity === value.entityIdentity && e.uuid === value.uuid
        : value.kind === 'block' && e.position.x === value.position.x && e.position.y === value.position.y
          && e.position.z === value.position.z && e.stateId === value.stateId));
    if (existing) {
      Object.assign(existing, value);
      return this.publicTarget(existing);
    }
    while (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
    const entry: Entry = { ...value, ref: randomUUID(), observedAt: now, expiresAt: now + this.ttlMs,
      dimension: this.bot.game.dimension, version: this.bot.version };
    this.entries.set(entry.ref, entry);
    return this.publicTarget(entry);
  }
  private publicTarget(entry: Entry): ObservedTarget {
    const { ref, kind, name, position, observedAt, expiresAt, droppedItem: item, entityKind } = entry;
    return { ref, kind, name, position: point(position), observedAt, expiresAt,
      ...(item ? { droppedItem: item } : {}), ...(entityKind ? { entityKind } : {}) };
  }
  observeEntity(entity: Bot['entity']): ObservedTarget {
    if (entity === this.bot.entity || entity.isValid === false || this.bot.entities[entity.id] !== entity || !this.inRange(entity.position,32)) {
      throw new ActionError('TARGET_NOT_OBSERVED', '实体不在当前客户端观测范围');
    }
    return this.add({ kind:'entity', name:entity.username ?? entity.name ?? 'entity', position:point(entity.position),
      entityId:entity.id, uuid:entity.uuid, entityIdentity:entity, entityKind:entityKind(entity), droppedItem:droppedItem(entity) });
  }
  observeBlock(position: Point): ObservedTarget | undefined {
    const block=this.bot.blockAt(new Vec3(position.x,position.y,position.z));
    if (!block || !this.inRange(position,32)) return undefined;
    return this.add({kind:'block',name:block.name,position:point(block.position),stateId:block.stateId});
  }
  registerPosition(position: Point) {
    if (!this.inRange(position, 32) || !this.bot.blockAt(new Vec3(position.x, position.y, position.z))) {
      throw new ActionError('POSITION_NOT_OBSERVED', '位置必须在32格内已加载区域；可分段探索，不证明位置可达');
    }
    return { target: this.add({ kind: 'position', name: 'local_position', position: point(position) }),
      scope: 'loaded_client_chunks', reachable: 'unknown' };
  }
  observe(query: z.infer<typeof targetQuerySchema>) {
    const b = this.bot;
    const targets: ObservedTarget[] = [];
    const names = [...new Set([...query.names,...query.blockNames])];
    const unknown = names.filter(name => !b.registry.blocksByName[name]);
    if (unknown.length) throw new ActionError('UNKNOWN_BLOCK', `未知方块: ${unknown.join(', ')}`);
    if (names.length) for (const position of b.findBlocks({ matching: names.map(name => b.registry.blocksByName[name]!.id),
      maxDistance: query.radius, count: query.limit })) {
      const block = b.blockAt(position);
      if (block && names.includes(block.name) && this.inRange(position, query.radius)) targets.push(this.add({
        kind: 'block', name: block.name, position: point(position), stateId: block.stateId,
      }));
    }
    if (query.placements) {
      const origin = b.entity.position.floored();
      // Enumerate local supported air cells. Selection belongs to the model.
      for (let x = -2; x <= 2 && targets.length < query.limit; x++) for (let z = -2; z <= 2 && targets.length < query.limit; z++) {
        const destination = origin.offset(x, 0, z), support = destination.offset(0, -1, 0);
        if (!this.inRange(destination, query.radius) || this.occupied(destination)) continue;
        const above = b.blockAt(destination), below = b.blockAt(support);
        if (!above || !empty(above.name) || !below || !solidSupport(below)) continue;
        targets.push(this.add({ kind: 'placement', name: 'supported_air', position: point(destination),
          stateId: above.stateId, support: point(support), supportState: below.stateId }));
      }
    }
    if (query.entities || query.entityNames.length || query.itemNames.length || query.entityKinds.length) for (const entity of Object.values(b.entities).filter(entity => entity !== b.entity
      && entity.isValid !== false && this.inRange(entity.position, query.radius))
      .filter(entity => (!query.entityNames.length || query.entityNames.includes(entity.username ?? entity.name ?? ''))
        && (!query.entityKinds.length || query.entityKinds.includes(entityKind(entity)))
        && (!query.itemNames.length || query.itemNames.includes(droppedItem(entity)?.name ?? '')))
      .sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))) {
      if (targets.length >= query.limit) break;
      targets.push(this.observeEntity(entity));
    }
    return { scope: 'loaded_client_chunks', completeWorldSearch: false, targets,
      limited: targets.length >= query.limit, ttlMs: this.ttlMs };
  }
  private occupied(position: Point) {
    return [this.bot.entity, ...Object.values(this.bot.entities)].some(entity => entity.isValid !== false
      && Math.abs(entity.position.x - position.x - 0.5) < 0.8
      && Math.abs(entity.position.z - position.z - 0.5) < 0.8
      && entity.position.y < position.y + 1 && entity.position.y + (entity.height ?? 2) > position.y);
  }
  validatePlacement(position: Point) {
    const block = this.bot.blockAt(new Vec3(position.x, position.y, position.z));
    if (!this.inRange(position, 32) || !block || !empty(block.name) || this.occupied(position)) {
      throw new ActionError('PLACEMENT_CHANGED', '放置目的地未加载或已被方块/实体占用');
    }
  }
  resolve(ref: string, kinds: Entry['kind'][]): Entry {
    const entry = this.entries.get(ref);
    if (!entry) throw new ActionError('UNKNOWN_TARGET_REF', '目标引用不属于当前 Bot 会话，请重新观察');
    if (entry.expiresAt <= this.now()) throw new ActionError('EXPIRED_TARGET_REF', '目标引用已过期，请重新观察');
    if (entry.dimension !== this.bot.game.dimension || entry.version !== this.bot.version) {
      throw new ActionError('STALE_TARGET_REF', '目标维度或版本已改变，请重新观察');
    }
    if (!kinds.includes(entry.kind)) throw new ActionError('TARGET_KIND_MISMATCH', '目标引用种类不适用于此操作');
    const position = entry.kind === 'entity' ? this.bot.entities[entry.entityId!]?.position : entry.position;
    if (!position || !this.inRange(position, 32)) throw new ActionError('TARGET_NOT_OBSERVED', '目标不在当前观测范围');
    if (entry.kind === 'entity') {
      const entity = this.bot.entities[entry.entityId!];
      if (!entity || entity.isValid === false || entity !== entry.entityIdentity || entity.uuid !== entry.uuid) throw new ActionError('STALE_TARGET_REF', '目标实体已改变');
      return { ...entry, position: point(position) };
    }
    if (entry.kind === 'position') {
      if (!this.bot.blockAt(new Vec3(position.x, position.y, position.z))) throw new ActionError('TARGET_NOT_OBSERVED', '探索位置已卸载');
      return entry;
    }
    const block = this.bot.blockAt(new Vec3(entry.position.x, entry.position.y, entry.position.z));
    if (!block || block.stateId !== entry.stateId) throw new ActionError('STALE_TARGET_REF', '目标方块已变化或卸载');
    if (entry.kind === 'placement') {
      const support = this.bot.blockAt(new Vec3(entry.support!.x, entry.support!.y, entry.support!.z));
      if (!empty(block.name) || !support || support.stateId !== entry.supportState || !solidSupport(support)
        || this.occupied(entry.position)) throw new ActionError('PLACEMENT_CHANGED', '放置位置已被占用或支撑发生变化');
    }
    return entry;
  }
}
