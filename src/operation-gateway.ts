import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { ActionError } from './executor.js';
import { nativeActionSchema, type BasicOperation, type NativeAction } from './schema.js';
import type { Observations } from './observation.js';

/** Bind references only after acquiring the existing ActionExecutor lease. */
export function bindOperation(op: BasicOperation, observations: Observations, bot: Bot): NativeAction {
  const target = (ref: string, kinds: Array<'block' | 'entity' | 'placement' | 'position'>) => observations.targets.resolve(ref, kinds);
  const block = (ref: string) => target(ref, ['block']).position;
  const entity = (ref: string) => target(ref, ['entity']).entityId!;
  const refs = observations.operationReferences;
  const recipe = (item:string, ref:string) => ref.startsWith('recipe:') ? observations.resolveRecipe(item,ref) : ref;
  let action: unknown;
  switch (op.type) {
    case 'navigate': case 'look_at': {
      const observed = target(op.targetRef, ['block', 'entity', 'placement', 'position']);
      const position = op.type === 'navigate' ? { x: Math.floor(observed.position.x), y: Math.floor(observed.position.y), z: Math.floor(observed.position.z) } : observed.position;
      action = op.type === 'navigate' ? { type: op.type, position, range: op.range } : { type: op.type, position }; break;
    }
    case 'place': {
      const observed = target(op.targetRef, ['block', 'placement']);
      if (bot.heldItem?.name !== op.item) throw new ActionError('HELD_ITEM_MISMATCH', '请先装备明确指定的方块物品');
      if (!bot.registry.blocksByName[op.item]) throw new ActionError('UNSUPPORTED_PLACEMENT_ITEM', '当前方块放置要求同名方块物品');
      if (observed.kind === 'placement' && op.face !== 'up') throw new ActionError('PLACEMENT_FACE_MISMATCH', '空气格候选只对应其支撑块的上表面');
      const reference = observed.kind === 'placement' ? observed.support! : observed.position;
      const faces = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
      const [x, y, z] = faces[op.face];
      observations.targets.validatePlacement(new Vec3(reference.x + x!, reference.y + y!, reference.z + z!));
      action = { type: 'place', reference, face: op.face }; break;
    }
    case 'place_entity': {
      if (bot.heldItem?.name !== op.item) throw new ActionError('HELD_ITEM_MISMATCH', '请先装备明确指定的实体物品');
      action = { type: op.type, reference: block(op.targetRef), face: op.face }; break;
    }
    case 'craft': action = { ...(op.count !== undefined ? { type: 'craft_output', outputCount: op.count }
      : { type: 'craft', repetitions: op.repetitions! }), item: op.item, recipeRef: recipe(op.item,op.recipeRef),
      ...(op.tableRef ? { table: block(op.tableRef) } : {}) }; break;
    case 'craft_output': {
      const { tableRef, ...rest } = op; action = { ...rest, recipeRef:recipe(op.item,op.recipeRef), ...(tableRef ? { table: block(tableRef) } : {}) }; break;
    }
    case 'inventory_move': action = { type: op.type, source: refs.item(op.sourceRef), destinationSlot: refs.empty(op.destinationRef) }; break;
    case 'trade': action = { type: op.type, entityId: entity(op.targetRef),
      offerFingerprint: refs.resolveQuote('offer', op.targetRef, op.offerRef).fingerprint, repetitions: op.repetitions }; break;
    case 'brewing_put': action = { type: op.type, position: block(op.targetRef), source: refs.item(op.sourceRef), destinationSlot: op.destinationSlot }; break;
    case 'brewing_take': {
      const quote = refs.resolveQuote('brewing', op.targetRef, op.itemRef);
      action = { type: op.type, position: block(op.targetRef), slot: quote.slot, fingerprint: quote.fingerprint }; break;
    }
    case 'enchant': action = { type: op.type, position: block(op.targetRef), target: refs.item(op.itemRef), choice: op.choice, maxLevelCost: op.maxLevelCost }; break;
    case 'anvil': action = { type: op.type, position: block(op.targetRef), target: refs.item(op.itemRef),
      ...(op.secondRef ? { second: refs.item(op.secondRef) } : {}), ...(op.rename !== undefined ? { rename: op.rename } : {}), maxLevelCost: op.maxLevelCost }; break;
    case 'wait_until': {
      const condition = op.condition;
      action = { type: op.type, condition: 'targetRef' in condition
        ? condition.kind === 'block_is' ? { kind: condition.kind, position: block(condition.targetRef), name: condition.name, properties: condition.properties }
          : { kind: condition.kind, entityId: entity(condition.targetRef), distance: condition.distance }
        : condition }; break;
    }
    default: {
      if ('targetRef' in op) {
        const { targetRef, ...rest } = op;
        const entityTypes = ['look_at_entity', 'follow', 'activate_entity', 'attack_once', 'activate_entity_at', 'trade_inspect', 'mount'];
        action = entityTypes.includes(op.type) ? { ...rest, entityId: entity(targetRef) } : { ...rest, position: block(targetRef) };
      } else action = op;
    }
  }
  // A new operation cannot accidentally forward unbound model fields to a plugin.
  const parsed = nativeActionSchema.safeParse(action);
  if (!parsed.success) throw new ActionError('INVALID_OPERATION_BINDING', '操作参数无法绑定到原生动作');
  return parsed.data;
}

const privateKeys = new Set(['slot', 'slots', 'fingerprint', 'offerFingerprint', 'entityId', 'vehicleId', 'resolvedIndex',
  'uuid', 'nbt', 'components', 'removedComponents', 'metadata', 'customName', 'sourceSlot', 'destinationSlot']);
export function safeOperationData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeOperationData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateKeys.has(key)).map(([key, entry]) => [key, safeOperationData(entry)]));
  return value;
}

/** Window reads remain leased actions; only opaque quotes leave the program. */
export function operationResult(op: BasicOperation, raw: unknown, observations: Observations): Record<string, unknown> {
  const data = raw as Record<string, any>;
  const safe = safeOperationData(raw) as Record<string, unknown>;
  if (op.type === 'trade_inspect') {
    const offers = Array.isArray(data.offers) ? data.offers : [];
    safe.offers = offers.slice(0, 16).map(offer => ({ ...(safeOperationData(offer) as object),
      offerRef: observations.operationReferences.quote('offer', op.targetRef, offer.fingerprint) }));
    safe.limited = offers.length > 16;
  }
  if (op.type === 'brewing_inspect') {
    safe.contents = (data.slots ?? []).map((entry: any) => ({
      role: ['bottle_1', 'bottle_2', 'bottle_3', 'ingredient', 'fuel'][entry.slot],
      item: safeOperationData(entry.item),
      itemRef: entry.item ? observations.operationReferences.quote('brewing', op.targetRef, entry.fingerprint, entry.slot) : null,
    }));
  }
  return { ...safe, operation: op.type,
    ...('targetRef' in op ? { targetRef: op.targetRef } : {}),
    ...('item' in op ? { item: op.item } : op.type === 'furnace_take' ? { item: op.expectedItem }
      : typeof data?.item?.name === 'string' ? { item: data.item.name }
      : typeof data?.output?.name === 'string' ? { item: data.output.name } : {}) };
}
