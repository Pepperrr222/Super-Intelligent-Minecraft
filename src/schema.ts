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
export const querySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), radius: number.min(1).max(32).default(16) }).strict(),
  z.object({ type: z.literal('inspect_block'), position: blockPosition }).strict(),
  z.object({ type: z.literal('find_blocks'), names: z.array(item).min(1).max(32), radius: number.int().min(1).max(32).default(16), limit: number.int().min(1).max(128).default(32) }).strict(),
  z.object({ type: z.literal('recipes'), item, table: blockPosition.optional() }).strict(),
  z.object({ type: z.literal('verify'), condition: conditionSchema }).strict()
]);

export const actionSchema = z.discriminatedUnion('type', [
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
  z.object({ type: z.literal('craft'), item, repetitions: number.int().min(1).max(64), table: blockPosition.optional() }).strict(),
  z.object({ type: z.literal('toss'), item, count }).strict(),
  z.object({ type: z.literal('container_transfer'), position: blockPosition, direction: z.enum(['deposit', 'withdraw']), item, count }).strict(),
  z.object({ type: z.literal('wait'), durationMs: duration }).strict(),
  z.object({ type: z.literal('wait_ticks'), ticks }).strict(),
  z.object({ type: z.literal('move_ticks'), controls: z.array(control).min(1).max(7), ticks }).strict(),
  z.object({ type: z.literal('use_item_ticks'), ticks, offHand: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('wait_until'), condition: conditionSchema }).strict(),
  z.object({ type: z.literal('place_entity'), reference: blockPosition, face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']) }).strict(),
  z.object({ type: z.literal('activate_entity_at'), entityId: number.int().nonnegative(), offset: position }).strict(),
  z.object({ type: z.literal('craft_output'), item, outputCount: count, table: blockPosition.optional() }).strict(),
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
export type Action = z.infer<typeof actionSchema>;
export const actionJsonSchema = z.toJSONSchema(actionSchema);
export const queryJsonSchema = z.toJSONSchema(querySchema);

export type ActionResult = {
  id: string;
  type: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'busy' | 'invalid' | 'not_ready';
  startedAt: number;
  finishedAt: number;
  data?: unknown;
  error?: { code: string; message: string };
};
