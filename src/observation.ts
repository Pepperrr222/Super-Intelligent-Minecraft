import { createHash, randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { querySchema, type Condition } from './schema.js';

export type Item = NonNullable<Bot['heldItem']>;
export const plain = (value: unknown): any => value == null ? null : JSON.parse(JSON.stringify(value, (_, v) =>
  typeof v === 'bigint' ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v));
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(plain(value)))).digest('hex');
const read = (fn: () => unknown) => { try { return plain(fn()); } catch { return null; } };
export function itemDetails(item: Item | null | undefined) {
  if (!item) return null;
  const runtime = item as Item & { components?: unknown; removedComponents?: unknown };
  return { name:item.name, count:item.count, metadata:item.metadata,
    durabilityUsed:read(() => item.durabilityUsed), maxDurability:item.maxDurability ?? null,
    enchants:read(() => item.enchants), customName:read(() => item.customName),
    components:read(() => runtime.components), removedComponents:read(() => runtime.removedComponents), nbt:read(() => item.nbt) };
}
export const itemFingerprint = (item: Item) => fingerprint(itemDetails(item));
export const itemIdentity = (item: Item) => fingerprint({ ...itemDetails(item), count:0 });
export type Verification = { value: true | false | 'unknown'; evidence: string; observed: unknown };

/** Only loaded client data within a bounded public perception radius; never server/grader data. */
export class Observations {
  readonly sessionId = randomUUID();
  tick = 0;
  private onTick = () => { this.tick++; };
  constructor(private bot: Bot, readonly radius = 32) { bot.on('physicsTick', this.onTick); }
  dispose() { this.bot.removeListener('physicsTick', this.onTick); }
  inRange(p: {x:number;y:number;z:number}, radius = this.radius) {
    return !!this.bot.entity && this.bot.entity.position.distanceTo(new Vec3(p.x,p.y,p.z)) <= radius;
  }
  inspectBlock(p: {x:number;y:number;z:number}) {
    if (!this.inRange(p)) return { known:false as const, reason:'OUTSIDE_PERCEPTION' };
    const block = this.bot.blockAt(new Vec3(p.x,p.y,p.z));
    if (!block) return { known:false as const, reason:'UNLOADED_BLOCK' };
    return { known:true as const, name:block.name, position:plain(block.position), stateId:block.stateId,
      properties:read(() => block.getProperties()), diggable:block.diggable };
  }
  snapshot(radius = 16) {
    const b = this.bot;
    const w = b.currentWindow;
    const inventory = w ? w.slots.slice(w.inventoryStart,w.inventoryEnd).flatMap((item,index)=>item ? [{item,slot:b.inventory.inventoryStart+index}] : [])
      : (b.inventory?.items() ?? []).map(item=>({item,slot:item.slot}));
    return { sessionId:this.sessionId, clientTick:this.tick, timestamp:Date.now(), version:b.version,
      perceptionRadius:Math.min(radius,this.radius), position:plain(b.entity?.position),
      velocity:plain(b.entity?.velocity), onGround:b.entity?.onGround ?? null,
      health:b.health, food:b.food, oxygen:b.oxygenLevel ?? null, experience:plain(b.experience),
      dimension:b.game?.dimension, gameMode:b.game?.gameMode, effects:plain(b.entity?.effects),
      vehicle:b.vehicle ? { id:b.vehicle.id, name:b.vehicle.name } : null,
      inventory:inventory.map(({item,slot}) => ({ ...itemDetails(item), slot, fingerprint:itemFingerprint(item) })),
      equipment: [5,6,7,8,45].map(slot => ({ slot, item:itemDetails(b.inventory?.slots[slot]) })),
      entities:Object.values(b.entities ?? {}).filter(e => e !== b.entity && e.isValid !== false && this.inRange(e.position,Math.min(radius,this.radius)))
        .map(e => ({ id:e.id, uuid:e.uuid ?? null, name:e.name, type:e.type, username:e.username,
          position:plain(e.position), velocity:plain(e.velocity), metadata:read(() => e.metadata),
          metadataMeaning:'raw_version_specific', observedTick:this.tick })) };
  }
  verify(condition: Condition): Verification {
    const b = this.bot;
    const unknown = (reason: string): Verification => ({ value:'unknown', evidence:reason, observed:null });
    if (!b.entity) return unknown('NOT_READY');
    switch (condition.kind) {
      case 'inventory_at_least': {
        const w = b.currentWindow, items = w ? w.slots.slice(w.inventoryStart,w.inventoryEnd) : b.inventory.items();
        const observed = items.filter(i => i?.name===condition.item).reduce((n,i)=>n+(i?.count ?? 0),0);
        return { value:observed>=condition.count, evidence:'client_inventory_count', observed };
      }
      case 'block_is': {
        const block = this.inspectBlock(condition.position);
        if (!block.known) return unknown(block.reason);
        if (block.name !== condition.name) return { value:false, evidence:'client_block', observed:block };
        for (const [key,value] of Object.entries(condition.properties ?? {})) {
          if (!block.properties || !(key in block.properties)) return unknown('UNDECODED_PROPERTY');
          if (block.properties[key] !== value) return { value:false, evidence:'client_block_property', observed:block };
        }
        return { value:true, evidence:'client_block', observed:block };
      }
      case 'dimension_is': return b.game?.dimension ? { value:b.game.dimension===condition.dimension, evidence:'client_dimension', observed:b.game.dimension } : unknown('DIMENSION_UNKNOWN');
      case 'health_at_least': return Number.isFinite(b.health) ? { value:b.health>=condition.health, evidence:'client_health', observed:b.health } : unknown('HEALTH_UNKNOWN');
      case 'entity_near': {
        const entity = b.entities[condition.entityId];
        if (!entity || entity.isValid===false || !this.inRange(entity.position)) return unknown('ENTITY_NOT_OBSERVED');
        const distance = b.entity.position.distanceTo(entity.position);
        return { value:distance<=condition.distance, evidence:'client_entity_distance', observed:distance };
      }
    }
  }
  query(input: unknown) {
    const parsed = querySchema.safeParse(input);
    if (!parsed.success) return { status:'invalid', error:parsed.error.message };
    if (!this.bot.entity) return { status:'not_ready' };
    const q = parsed.data, b = this.bot;
    switch (q.type) {
      case 'snapshot': return { status:'succeeded', data:this.snapshot(q.radius) };
      case 'inspect_block': return { status:'succeeded', data:this.inspectBlock(q.position) };
      case 'verify': return { status:'succeeded', data:this.verify(q.condition) };
      case 'find_blocks': {
        const unknown = q.names.filter(n => !b.registry.blocksByName[n]);
        if (unknown.length) return { status:'invalid', error:`UNKNOWN_BLOCK: ${unknown.join(', ')}` };
        const positions = b.findBlocks({ matching:q.names.map(n=>b.registry.blocksByName[n].id), maxDistance:Math.min(q.radius,this.radius), count:q.limit });
        return { status:'succeeded', data:{ scope:'loaded_client_chunks', completeWorldSearch:false, blocks:positions.filter(p=>this.inRange(p,q.radius)).map(p=>this.inspectBlock(p)) } };
      }
      case 'recipes': {
        const item = b.registry.itemsByName[q.item];
        if (!item) return { status:'invalid', error:'UNKNOWN_ITEM' };
        if (q.table && !this.inRange(q.table)) return { status:'invalid', error:'OUTSIDE_PERCEPTION' };
        const table = q.table ? b.blockAt(new Vec3(q.table.x,q.table.y,q.table.z)) : null;
        if (q.table && table?.name!=='crafting_table') return { status:'invalid', error:'NO_OBSERVED_CRAFTING_TABLE' };
        return { status:'succeeded', data:plain(b.recipesFor(item.id,null,1,table).map(r=>({ result:r.result, delta:r.delta, requiresTable:r.requiresTable }))) };
      }
    }
  }
}
