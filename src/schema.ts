import { z } from 'zod';

const number = z.number().finite();
const position = z.object({ x: number, y: number, z: number }).strict();
const blockPosition = z.object({ x: number.int(), y: number.int(), z: number.int() }).strict();
const duration = number.int().min(1).max(120_000);
const item = z.string().min(1).max(100);
const count = number.int().min(1).max(2304);
const destination = z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']);
const control = z.enum(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']);
const ticks = number.int().min(1).max(2400);
export const slotRefSchema = z.object({ slot: number.int().min(9).max(44), fingerprint: z.string().length(64) }).strict();
export const conditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inventory_at_least'), item, count }).strict(),
  z.object({ kind: z.literal('block_is'), position: blockPosition, name: item,
    properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }).strict(),
  z.object({ kind: z.literal('dimension_is'), dimension: item }).strict(),
  z.object({ kind: z.literal('entity_near'), entityId: number.int().nonnegative(), distance: number.min(0).max(32) }).strict(),
  z.object({ kind: z.literal('health_at_least'), health: number.min(0).max(20) }).strict()
]);
export type Condition = z.infer<typeof conditionSchema>;
export const recipeRefSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const recipeSelectionSchema = z.string().regex(/^(?:[a-f0-9]{64}|recipe:[a-f0-9]{16})$/u);
export const requirementsParamsSchema = z.object({
  goals: z.array(z.object({ item, count }).strict()).min(1).max(16),
  mode: z.enum(['total', 'additional']).default('total'),
  facilities: z.array(z.literal('crafting_table')).max(1).default([]),
  maxDepth: number.int().min(1).max(16).default(8),
  maxNodes: number.int().min(1).max(512).default(128),
  maxAlternatives: number.int().min(1).max(32).default(6),
  recipeRefs: z.record(item, recipeRefSchema).optional(),
}).strict();
export const knowledgeQuerySchema = z.discriminatedUnion('type', [
  requirementsParamsSchema.omit({ recipeRefs: true }).extend({ type:z.literal('crafting_options'),
    includeDependencies:z.boolean().default(true), expandMembers:z.boolean().default(false) }).strict(),
  z.object({type:z.literal('container_memory'), items:z.array(item).max(32).default([]), limit:number.int().min(1).max(32).default(16)}).strict(),
  z.object({ type: z.literal('recipe_lookup'), item,
    offset: number.int().min(0).max(10000).default(0), limit: number.int().min(1).max(32).default(8) }).strict(),
  z.object({ type: z.literal('recipe_evaluate'), item, recipeRef: recipeRefSchema, count,
    facilities: z.array(z.literal('crafting_table')).max(1).default([]) }).strict(),
  requirementsParamsSchema.extend({ type: z.literal('requirements_expand') }).strict(),
]);
export type KnowledgeQuery = z.infer<typeof knowledgeQuerySchema>;
const targetRef = z.string().uuid();
export const targetQuerySchema = z.object({
  type: z.literal('observe_targets'), names: z.array(item).max(16).default([]).describe('Legacy block-name filter only. For dropped items use itemNames.'),
  blockNames: z.array(item).max(16).default([]).describe('Block names, e.g. spruce_log. Does not filter entities.'),
  entityNames: z.array(item).max(16).default([]).describe('Entity names or player names, e.g. zombie. Implies entities=true.'),
  itemNames: z.array(item).max(16).default([]).describe('Dropped item contents, e.g. iron_ingot. Implies entityKinds=[item] and entities=true.'),
  entityKinds: z.array(z.enum(['player','item','mob','other'])).max(4).default([]).describe('Filter entities by kind. Use [item] for all dropped items, including unknown contents.'),
  radius: number.int().min(1).max(16).default(8), limit: number.int().min(1).max(16).default(8),
  placements: z.boolean().default(false), entities: z.boolean().default(false),
}).strict();
export const nativeActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), controls: z.array(control).min(1).max(7), durationMs: duration }).strict(),
  z.object({ type: z.literal('look'), yaw: number, pitch: number.min(-Math.PI / 2).max(Math.PI / 2) }).strict(),
  z.object({ type: z.literal('look_at'), position }).strict(),
  z.object({ type: z.literal('look_at_entity'), entityId: number.int().nonnegative(), part: z.enum(['head', 'body', 'legs', 'feet']).default('head') }).strict(),
  z.object({ type: z.literal('navigate'), position: blockPosition, range: number.min(0).max(16).default(1) }).strict(),
  z.object({ type: z.literal('follow'), entityId: number.int().nonnegative(), distance: number.min(1).max(16).default(2), durationMs: duration }).strict(),
  z.object({ type: z.literal('dig'), position: blockPosition }).strict(),
  z.object({ type: z.literal('place'), reference: blockPosition, face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']) }).strict(),
  z.object({ type: z.literal('equip'), item, destination: destination.default('hand') }).strict(),
  z.object({ type: z.literal('unequip'), destination }).strict(),
  z.object({ type: z.literal('select_slot'), slot: number.int().min(0).max(8) }).strict(),
  z.object({ type: z.literal('use_item'), durationMs: duration, offHand: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('consume') }).strict(),
  z.object({ type: z.literal('activate_block'), position: blockPosition }).strict(),
  z.object({ type: z.literal('activate_entity'), entityId: number.int().nonnegative() }).strict(),
  z.object({ type: z.literal('attack_once'), entityId: number.int().nonnegative() }).strict(),
  z.object({ type: z.literal('craft'), item, repetitions: number.int().min(1).max(64), table: blockPosition.optional(), recipeRef: recipeRefSchema.optional() }).strict(),
  z.object({ type: z.literal('toss'), item, count }).strict(),
  z.object({ type: z.literal('container_transfer'), position: blockPosition, direction: z.enum(['deposit', 'withdraw']), item, count }).strict(),
  z.object({ type: z.literal('wait'), durationMs: duration }).strict(),
  z.object({ type: z.literal('wait_ticks'), ticks }).strict(),
  z.object({ type: z.literal('move_ticks'), controls: z.array(control).min(1).max(7), ticks }).strict(),
  z.object({ type: z.literal('use_item_ticks'), ticks, offHand: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('wait_until'), condition: conditionSchema }).strict(),
  z.object({ type: z.literal('place_entity'), reference: blockPosition, face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']) }).strict(),
  z.object({ type: z.literal('activate_entity_at'), entityId: number.int().nonnegative(), offset: position }).strict(),
  z.object({ type: z.literal('craft_output'), item, outputCount: count, table: blockPosition.optional(), recipeRef: recipeRefSchema.optional() }).strict(),
  z.object({ type: z.literal('container_inspect'), position: blockPosition }).strict(),
  z.object({ type: z.literal('inventory_move'), source: slotRefSchema, destinationSlot: number.int().min(9).max(44) }).strict(),
  z.object({ type: z.literal('furnace_inspect'), position: blockPosition }).strict(),
  z.object({ type: z.literal('furnace_put'), position: blockPosition, slot: z.enum(['input', 'fuel']), item, count }).strict(),
  z.object({ type: z.literal('furnace_take'), position: blockPosition, slot: z.enum(['input', 'fuel', 'output']), expectedItem: item, minCount: count.default(1) }).strict(),
  z.object({ type: z.literal('brewing_inspect'), position: blockPosition }).strict(),
  z.object({ type: z.literal('brewing_put'), position: blockPosition, source: slotRefSchema, destinationSlot: number.int().min(0).max(4) }).strict(),
  z.object({ type: z.literal('brewing_take'), position: blockPosition, slot: number.int().min(0).max(4), fingerprint: z.string().length(64) }).strict(),
  z.object({ type: z.literal('trade_inspect'), entityId: number.int().nonnegative() }).strict(),
  z.object({ type: z.literal('trade'), entityId: number.int().nonnegative(), offerFingerprint: z.string().length(64), repetitions: number.int().min(1).max(64) }).strict(),
  z.object({ type: z.literal('enchant'), position: blockPosition, target: slotRefSchema, choice: number.int().min(0).max(2), maxLevelCost: number.int().min(1).max(3) }).strict(),
  z.object({ type: z.literal('anvil'), position: blockPosition, target: slotRefSchema, second: slotRefSchema.optional(), rename: z.string().min(1).max(35).optional(), maxLevelCost: number.int().min(1).max(39) }).strict(),
  z.object({ type: z.literal('fish_once') }).strict(),
  z.object({ type: z.literal('mount'), entityId: number.int().nonnegative() }).strict(),
  z.object({ type: z.literal('vehicle_control'), left: number.min(-1).max(1), forward: number.min(-1).max(1), ticks }).strict(),
  z.object({ type: z.literal('dismount') }).strict(),
  z.object({ type: z.literal('say'), message: z.string().trim().min(1).max(200) }).strict()
]);
export type NativeAction = z.infer<typeof nativeActionSchema>;
type NativeSchema<T extends NativeAction['type']> = Extract<(typeof nativeActionSchema.options)[number], { shape: { type: z.ZodLiteral<T> } }>;
const native = <T extends NativeAction['type']>(type: T) => nativeActionSchema.options.find(option => option.shape.type.value === type) as NativeSchema<T>;
export const modelConditionSchema = z.discriminatedUnion('kind', [
  conditionSchema.options[0], conditionSchema.options[1].omit({ position: true }).extend({ targetRef }),
  conditionSchema.options[2], conditionSchema.options[3].omit({ entityId: true }).extend({ targetRef }), conditionSchema.options[4],
]);
export const basicOperationSchema = z.discriminatedUnion('type', [
  native('move'), native('look'), native('equip').extend({ destination }), native('unequip'), native('select_slot'), native('use_item').extend({ offHand: z.boolean() }), native('consume'),
  native('toss'), native('wait'), native('wait_ticks'), native('move_ticks'), native('use_item_ticks').extend({ offHand: z.boolean() }), native('fish_once'),
  native('vehicle_control'), native('dismount'), native('say'),
  native('look_at').omit({ position: true }).extend({ targetRef }),
  native('look_at_entity').omit({ entityId: true }).extend({ targetRef, part: z.enum(['head', 'body', 'legs', 'feet']) }),
  native('navigate').omit({ position: true }).extend({ targetRef, range: number.min(0).max(16) }),
  native('follow').omit({ entityId: true }).extend({ targetRef, distance: number.min(1).max(16) }),
  native('dig').omit({ position: true }).extend({ targetRef }),
  native('place').omit({ reference: true }).extend({ targetRef, item, face: native('place').shape.face }),
  native('activate_block').omit({ position: true }).extend({ targetRef }),
  native('activate_entity').omit({ entityId: true }).extend({ targetRef }),
  native('attack_once').omit({ entityId: true }).extend({ targetRef }),
  z.object({ type: z.literal('craft'), item, count: count.optional(), repetitions: native('craft').shape.repetitions.optional(), recipeRef: recipeSelectionSchema, tableRef: targetRef.optional() })
    .strict().refine(value => (value.count !== undefined) !== (value.repetitions !== undefined), '指定 count 或 repetitions 中的一项'),
  native('container_transfer').omit({ position: true }).extend({ targetRef }),
  native('wait_until').extend({ condition: modelConditionSchema }),
  native('place_entity').omit({ reference: true }).extend({ targetRef, item }),
  native('activate_entity_at').omit({ entityId: true }).extend({ targetRef }),
  native('craft_output').omit({ table: true }).extend({ tableRef: targetRef.optional(), recipeRef: recipeSelectionSchema }),
  native('container_inspect').omit({ position: true }).extend({ targetRef }),
  native('inventory_move').omit({ source: true, destinationSlot: true }).extend({ sourceRef: targetRef, destinationRef: targetRef }),
  native('furnace_inspect').omit({ position: true }).extend({ targetRef }),
  native('furnace_put').omit({ position: true }).extend({ targetRef }),
  native('furnace_take').omit({ position: true }).extend({ targetRef, minCount: count }),
  native('brewing_inspect').omit({ position: true }).extend({ targetRef }),
  native('brewing_put').omit({ position: true, source: true }).extend({ targetRef, sourceRef: targetRef }),
  native('brewing_take').omit({ position: true, fingerprint: true, slot: true }).extend({ targetRef, itemRef: targetRef }),
  native('trade_inspect').omit({ entityId: true }).extend({ targetRef }),
  native('trade').omit({ entityId: true, offerFingerprint: true }).extend({ targetRef, offerRef: targetRef }),
  native('enchant').omit({ position: true, target: true }).extend({ targetRef, itemRef: targetRef }),
  native('anvil').omit({ position: true, target: true, second: true }).extend({ targetRef, itemRef: targetRef, secondRef: targetRef.optional() }),
  native('mount').omit({ entityId: true }).extend({ targetRef }),
]);
export type BasicOperation = z.infer<typeof basicOperationSchema>;
/** Public schemas describe accepted inputs, including defaults and cross-field rules. */
export function inputJsonSchema(schema: z.ZodType): z.core.JSONSchema.BaseSchema {
  return z.toJSONSchema(schema, { io: 'input', override: ({ jsonSchema }) => {
    const type = jsonSchema.properties?.type;
    if (type && typeof type === 'object' && type.const === 'craft' && jsonSchema.properties?.count && jsonSchema.properties.repetitions) {
      jsonSchema.oneOf = [
        { required: ['count'], not: { required: ['repetitions'] } },
        { required: ['repetitions'], not: { required: ['count'] } },
      ];
    }
  } });
}
export const basicOperationJsonSchema = inputJsonSchema(basicOperationSchema);
export const inventoryReferencesQuerySchema = z.object({ type: z.literal('observe_inventory'), offset: number.int().min(0).max(36).default(0), limit: number.int().min(1).max(16).default(8) }).strict();
export const operationSchemaQuerySchema = z.object({ type: z.literal('operation_schema'), types: z.array(z.string().min(1).max(64)).min(1).max(4) }).strict();
export const modelQuerySchema = z.discriminatedUnion('type', [...knowledgeQuerySchema.options, targetQuerySchema, inventoryReferencesQuerySchema, operationSchemaQuerySchema]);
export type ModelQuery = z.infer<typeof modelQuerySchema>;
export const querySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('register_position'), position: blockPosition }).strict(),
  targetQuerySchema, inventoryReferencesQuerySchema, operationSchemaQuerySchema,
  z.object({ type: z.literal('snapshot'), radius: number.min(1).max(32).default(16) }).strict(),
  z.object({ type: z.literal('inspect_block'), position: blockPosition }).strict(),
  z.object({ type: z.literal('find_blocks'), names: z.array(item).min(1).max(32), radius: number.int().min(1).max(32).default(16), limit: number.int().min(1).max(128).default(32) }).strict(),
  z.object({ type: z.literal('recipes'), item, table: blockPosition.optional() }).strict(),
  z.object({ type: z.literal('verify'), condition: conditionSchema }).strict(), ...knowledgeQuerySchema.options,
]);
export const actionSchema = z.discriminatedUnion('type', [...nativeActionSchema.options, z.object({ type: z.literal('operate'), operation: basicOperationSchema }).strict()]);
export type Action = z.infer<typeof actionSchema>;
export const actionJsonSchema = inputJsonSchema(actionSchema);
export const queryJsonSchema = inputJsonSchema(querySchema);

export type ActionResult = {
  id: string;
  type: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'busy' | 'invalid' | 'not_ready';
  startedAt: number;
  finishedAt: number;
  data?: unknown;
  error?: { code: string; message: string };
};
