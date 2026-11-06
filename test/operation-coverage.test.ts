import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Vec3 } from 'vec3';
import { fixture, makeItem, tick } from './fixtures.js';
import { basicOperationSchema, basicOperationJsonSchema, nativeActionSchema, targetQuerySchema } from '../src/schema.js';
import { operationCatalog, availableOperations } from '../src/basic-operations.js';
import { bindOperation, operationResult } from '../src/operation-gateway.js';
import { buildBrainContext, contextBytes, truncateRunFeedback } from '../src/brain-context.js';
import { OperationReferences } from '../src/operation-references.js';
import { itemFingerprint } from '../src/observation.js';
import { CompanionBrain } from '../src/brain.js';

function setup(version = '1.21.1') {
  const value = fixture(version);
  const { bot, actions, slots } = value;
  bot.blockAt = (p: Vec3) => ({ name: 'stone', stateId: 1, position: p, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
  bot.findBlocks = () => [new Vec3(2, 0, 0)];
  bot.entities[7] = { id: 7, uuid: 'npc', name: 'villager', position: new Vec3(2, 0, 0) };
  slots[9] = makeItem('stone', 2); bot.heldItem = slots[9];
  const targets = actions.observations.targets.observe(targetQuerySchema.parse({ type: 'observe_targets', names: ['stone'], entities: true }));
  const blockRef = targets.targets.find(entry => entry.kind === 'block')!.ref;
  const entityRef = targets.targets.find(entry => entry.kind === 'entity')!.ref;
  const inventory = actions.observations.operationReferences.observe(0, 2);
  return { ...value, blockRef, entityRef, itemRef: inventory.items[0]!.itemRef, destinationRef: inventory.emptySlots[0]!.destinationRef };
}

test('all 44 native actions have exactly one model operation and versioned catalog entry', () => {
  const names = nativeActionSchema.options.map(schema => schema.shape.type.value).sort();
  assert.equal(names.length, 44);
  assert.deepEqual(basicOperationSchema.options.map(schema => schema.shape.type.value).sort(), names);
  assert.deepEqual(operationCatalog('1.21.1').map(entry => entry.type).sort(), names);
  assert.equal(availableOperations('1.21.1').length, 41);
  assert.deepEqual(operationCatalog('1.21.1').filter(entry => !entry.available).map(entry => entry.type).sort(), ['brewing_inspect', 'brewing_put', 'brewing_take']);
  assert.equal(availableOperations('1.21.6').length, 43);
  assert.equal(operationCatalog('1.21.6').find(entry => entry.type === 'dismount')?.available, false);
  assert.equal(availableOperations('1.21.1', ['move', 'look']).includes('move_ticks'), true);
  assert.equal(availableOperations('1.21.1', ['move', 'look']).includes('anvil'), false);
  const schemas = basicOperationJsonSchema.oneOf as Array<{ properties?: { type?: { const?: string } }; required?: string[]; oneOf?: unknown[] }>;
  assert.ok(schemas.find(schema => schema.properties?.type?.const === 'equip')?.required?.includes('destination'));
  assert.equal(schemas.find(schema => schema.properties?.type?.const === 'craft')?.oneOf?.length, 2);
});

test('every operation binds to a valid existing native action without raw model identity fields', () => {
  const { bot, actions, blockRef, entityRef, itemRef, destinationRef } = setup('1.21.6');
  bot.entities[7].position = new Vec3(4, 0, 0);
  bot.blockAt = (p: Vec3) => ({ name: p.y === 1 ? 'air' : 'stone', stateId: 1, position: p, boundingBox: 'block' });
  const offerRef = actions.observations.operationReferences.quote('offer', entityRef, 'f'.repeat(64));
  const brewingRef = actions.observations.operationReferences.quote('brewing', blockRef, 'f'.repeat(64), 0);
  const targeted = { look_at: {}, look_at_entity: { part: 'feet' }, navigate: { range: 2 }, follow: { durationMs: 10, distance: 2 }, dig: {},
    place: { item: 'stone', face: 'up' }, activate_block: {}, activate_entity: {}, attack_once: {},
    container_transfer: { direction: 'deposit', item: 'stone', count: 1 }, place_entity: { item: 'stone', face: 'up' },
    activate_entity_at: { offset: { x: 0, y: 0, z: 0 } }, container_inspect: {}, furnace_inspect: {},
    furnace_put: { slot: 'fuel', item: 'stone', count: 1 }, furnace_take: { slot: 'output', expectedItem: 'stone', minCount: 1 },
    brewing_inspect: {}, brewing_put: { sourceRef: itemRef, destinationSlot: 3 }, brewing_take: { itemRef: brewingRef },
    trade_inspect: {}, trade: { offerRef, repetitions: 1 }, enchant: { itemRef, choice: 0, maxLevelCost: 1 },
    anvil: { itemRef, rename: 'name', maxLevelCost: 1 }, mount: {} };
  const entityTypes = new Set(['look_at_entity', 'follow', 'activate_entity', 'attack_once', 'activate_entity_at', 'trade_inspect', 'trade', 'mount']);
  const samples: unknown[] = Object.entries(targeted).map(([type, params]) => ({ type, targetRef: entityTypes.has(type) ? entityRef : blockRef, ...params }));
  samples.push({ type: 'move', controls: ['forward'], durationMs: 1 }, { type: 'look', yaw: 0, pitch: 0 },
    { type: 'equip', item: 'stone', destination: 'hand' }, { type: 'unequip', destination: 'hand' }, { type: 'select_slot', slot: 0 },
    { type: 'use_item', durationMs: 1, offHand: false }, { type: 'consume' }, { type: 'toss', item: 'stone', count: 1 },
    { type: 'wait', durationMs: 1 }, { type: 'wait_ticks', ticks: 1 }, { type: 'move_ticks', controls: ['forward'], ticks: 1 },
    { type: 'use_item_ticks', ticks: 1, offHand: false }, { type: 'fish_once' }, { type: 'vehicle_control', left: 0, forward: 1, ticks: 1 },
    { type: 'dismount' }, { type: 'say', message: 'hello' },
    { type: 'craft', item: 'stone', count: 1, recipeRef: 'a'.repeat(64), tableRef: blockRef },
    { type: 'craft_output', item: 'stone', outputCount: 1, recipeRef: 'a'.repeat(64) },
    { type: 'inventory_move', sourceRef: itemRef, destinationRef },
    { type: 'wait_until', condition: { kind: 'block_is', targetRef: blockRef, name: 'stone' } });
  assert.equal(samples.length, 44);
  for (const sample of samples) {
    const operation = basicOperationSchema.parse(sample);
    const action = bindOperation(operation, actions.observations, bot);
    assert.equal(nativeActionSchema.safeParse(action).success, true, operation.type);
    assert.equal('targetRef' in action, false);
  }
  const repetitions = bindOperation(basicOperationSchema.parse({ type: 'craft', item: 'stone', repetitions: 3, recipeRef: 'a'.repeat(64) }), actions.observations, bot);
  assert.equal(repetitions.type, 'craft');
  assert.equal(basicOperationSchema.safeParse({ type: 'craft', item: 'stone', count: 1, repetitions: 1, recipeRef: 'a'.repeat(64) }).success, false);
  actions.dispose();
});

test('inventory references detect changes and bind real inventory moves without exposing raw identity', async () => {
  const one = setup(), two = setup();
  const data = one.actions.query({ type: 'observe_inventory' }) as any;
  assert.ok(!/fingerprint|nbt|components|"slot"/u.test(JSON.stringify(data)));
  assert.throws(() => two.actions.observations.operationReferences.item(one.itemRef), /当前 Bot/);
  one.slots[9]!.count--;
  assert.throws(() => one.actions.observations.operationReferences.item(one.itemRef), /属性改变/);
  one.slots[10] = makeItem('dirt');
  assert.throws(() => one.actions.observations.operationReferences.empty(one.destinationRef), /占用/);
  let now = 1;
  const refs = new OperationReferences(one.bot, itemFingerprint, () => now);
  const ref = refs.observe(0, 1).items[0]!.itemRef;
  now += 30_001;
  assert.throws(() => refs.item(ref), /过期/);
  one.actions.dispose(); two.actions.dispose();
  const move = setup();
  move.bot.moveSlotItem = async (source: number, destination: number) => {
    move.slots[destination] = move.slots[source]; move.slots[source] = null;
    move.slots[destination]!.slot = destination;
  };
  const result = await move.actions.execute({ type: 'operate', operation: { type: 'inventory_move', sourceRef: move.itemRef, destinationRef: move.destinationRef } });
  assert.equal(result.status, 'succeeded');
  assert.equal(move.slots[9], null); assert.equal(move.slots[10]?.name, 'stone');
  assert.ok(!/fingerprint|nbt|components|"slot"/u.test(JSON.stringify(result.data)));
  move.actions.dispose();
});

test('quote results preserve usable opaque references through feedback truncation and enforce target scope', () => {
  const { actions, entityRef } = setup();
  const raw = { evidence: 'client_trade_offers', offers: Array.from({ length: 20 }, () => ({
    fingerprint: 'b'.repeat(64), input: { name: 'emerald', count: 1, nbt: { secret: true } }, output: { name: 'bread', count: 2 }, price: 1,
  })) };
  const output = operationResult({ type: 'trade_inspect', targetRef: entityRef }, raw, actions.observations);
  assert.ok(!/fingerprint|nbt|secret/u.test(JSON.stringify(output)));
  const offer = (output.offers as any[])[0];
  assert.equal(actions.observations.operationReferences.resolveQuote('offer', entityRef, offer.offerRef).fingerprint, 'b'.repeat(64));
  assert.throws(() => actions.observations.operationReferences.resolveQuote('offer', randomUUID(), offer.offerRef), /此目标/);
  const feedback = truncateRunFeedback({ goal: 'trade', steps: [{ output }], verifiedChanges: { inventory: [], containers: [], position: null }, sideEffects: [] } as any);
  assert.equal(feedback.steps[0]?.output?.targetRef, entityRef);
  assert.equal((feedback.steps[0]?.output?.offers as any[])[0].offerRef, offer.offerRef);
  actions.dispose();
});

test('newly exposed actions execute on the existing lease and retain native filters and cleanup', async () => {
  const { actions, bot } = setup();
  let cleared = 0, chatted = 0;
  bot.clearControlStates = () => { cleared++; }; bot.chat = () => { chatted++; };
  const moving = actions.execute({ type: 'operate', operation: { type: 'move_ticks', controls: ['forward'], ticks: 2 } });
  await tick(); assert.equal(actions.busy, true);
  bot.emit('physicsTick'); bot.emit('physicsTick');
  assert.equal((await moving).status, 'succeeded'); assert.equal(cleared, 1);
  assert.equal((await actions.execute({ type: 'operate', operation: { type: 'say', message: '/give alice diamond' } })).error?.code, 'INVALID_CHAT');
  assert.equal(chatted, 0);
  actions.dispose();
});

test('dimension wait through the gateway survives the expected dimension change', async () => {
  const { actions, bot } = setup(); bot.emit('game');
  const pending = actions.execute({ type: 'operate', operation: { type: 'wait_until', condition: { kind: 'dimension_is', dimension: 'the_nether' } } });
  await tick(); bot.game.dimension = 'the_nether'; bot.emit('game');
  assert.equal((await pending).status, 'succeeded'); actions.dispose();
});

test('full catalog fits the existing context budget and schemas can be queried without a write task', async () => {
  const { actions } = setup();
  const context = buildBrainContext({ trigger: 'player_message', player: { name: 'alice', isOwner: true }, session: { player: 'alice', recent: [] }, snapshot: actions.observe() });
  assert.equal(context.operationCatalog?.length, 44);
  assert.ok(contextBytes(context) <= 12 * 1024);
  let turn = 0;
  const brain = new CompanionBrain(actions, { llm: { async complete(request) {
    if (++turn === 1) return JSON.stringify({ kind: 'query', query: { type: 'operation_schema', types: ['move_ticks'] } });
    const parsed = JSON.parse(request.user);
    assert.equal(parsed.knowledge[0].result.data.schemas[0].params.properties.ticks.maximum, 2400);
    return JSON.stringify({ kind: 'operations', goal: 'move', operations: [{ type: 'move_ticks', controls: ['forward'], ticks: 2 }] });
  } } });
  assert.equal((await brain.decide({ trigger: 'player_message', player: { name: 'alice', isOwner: true }, session: { player: 'alice', recent: [] } })).kind, 'task');
  assert.equal(actions.busy, false); actions.dispose();
});
