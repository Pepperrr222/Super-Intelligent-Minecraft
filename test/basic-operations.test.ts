import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { fixture, tick } from './fixtures.js';
import { TargetRegistry } from '../src/targets.js';
import { targetQuerySchema, actionSchema } from '../src/schema.js';
import { CompanionBrain } from '../src/brain.js';
import { DecisionValidator, parseDecision } from '../src/brain-decision.js';
import { buildSkillCards } from '../src/brain-context.js';
import { availableOperations } from '../src/basic-operations.js';
import { TaskScheduler } from '../src/scheduler.js';
import { ActionController } from '../src/controller.js';
import { buildRunFeedback, callKey, failureEntries } from '../src/brain-feedback.js';
import type { BasicOperation } from '../src/schema.js';
import type { DecisionValidationContext } from '../src/brain-decision.js';

const require = createRequire(import.meta.url);
const native = createRequire(require.resolve('mineflayer'));
function setup() {
  const setup = fixture('1.21.1');
  const { bot, slots } = setup;
  const blocks = new Map<string, string>();
  const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
  bot.blockAt = (p: Vec3) => {
    const name = blocks.get(key(p)) ?? (p.y < 0 ? 'stone' : 'air');
    return { name, position: p.clone(), stateId: bot.registry.blocksByName[name].minStateId,
      boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], diggable: name !== 'air', getProperties: () => ({}) };
  };
  bot.findBlocks = ({ matching, count }: any) => [...blocks].filter(([, name]) => matching.includes(bot.registry.blocksByName[name].id))
    .slice(0, count).map(([p]) => new Vec3(...p.split(',').map(Number) as [number, number, number]));
  bot.pathfinder.goto = async (goal: any) => { bot.entity.position = new Vec3(goal.x, goal.y, goal.z); };
  bot.lookAt = async () => {};
  bot.canDigBlock = () => true; bot.stopDigging = () => {};
  bot.dig = async (block: any) => { blocks.set(key(block.position), 'air'); };
  const put = (name: string, count: number) => {
    let slot = slots.findIndex(item => item?.name === name);
    if (slot < 0) slot = slots.findIndex((item, index) => index >= 9 && index < 45 && !item);
    slots[slot] = count > 0 ? { name, count, slot, type: bot.registry.itemsByName[name].id, metadata: 0 } as any : null;
  };
  bot.equip = async (item: any, destination: string) => {
    if (destination === 'hand') bot.heldItem = item;
    else slots[({ 'off-hand': 45, head: 5, torso: 6, legs: 7, feet: 8 } as any)[destination]] = item;
  };
  bot.placeBlock = async (block: any, face: Vec3) => {
    blocks.set(key(block.position.plus(face)), bot.heldItem.name);
    put(bot.heldItem.name, bot.heldItem.count - 1); bot.heldItem = null;
  };
  const { Recipe } = native('prismarine-recipe')(bot.registry);
  bot.recipesAll = (id: number) => Recipe.find(id, null);
  bot.craft = async (recipe: any, repetitions: number) => {
    for (const delta of recipe.delta) {
      const name = bot.registry.items[delta.id].name;
      const amount = slots.filter(item => item?.name === name).reduce((sum, item) => sum + item!.count, 0);
      put(name, amount + delta.count * repetitions);
    }
  };
  bot._syncWindow = async () => {};
  return { ...setup, blocks, put };
}
const observe = (actions: ReturnType<typeof setup>['actions'], input: Record<string, unknown>) => {
  const result = actions.query({ type: 'observe_targets', ...input }) as any;
  assert.equal(result.status, 'succeeded'); return result.data.targets as Array<{ ref: string; kind: string; name: string; position: Vec3 }>;
};
const operate = (operation: BasicOperation) => ({ type: 'operate' as const, operation });

test('target observations expose opaque public references and conservative placement candidates', () => {
  const { actions, blocks } = setup();
  blocks.set('2,0,0', 'crafting_table');
  const targets = observe(actions, { names: ['crafting_table'], placements: true, limit: 16 });
  assert.equal(targets[0]?.name, 'crafting_table');
  assert.ok(targets.some(target => target.kind === 'placement'));
  assert.ok(!JSON.stringify(targets).includes('stateId'));
  assert.ok(!JSON.stringify(targets).includes('entityId'));
  assert.ok(!targets.some(target => target.kind === 'placement' && target.position.x === 0 && target.position.z === 0));
  actions.dispose();
});

test('unknown, cross-Bot, expired, changed and dimension-stale references fail closed', async () => {
  const one = setup(), two = setup();
  one.blocks.set('2,0,0', 'crafting_table');
  const ref = observe(one.actions, { names: ['crafting_table'] })[0]!.ref;
  assert.equal((await two.actions.execute(operate({ type: 'navigate', targetRef: ref, range: 2 }))).error?.code, 'UNKNOWN_TARGET_REF');
  one.blocks.set('2,0,0', 'stone');
  assert.equal((await one.actions.execute(operate({ type: 'navigate', targetRef: ref, range: 2 }))).error?.code, 'STALE_TARGET_REF');
  one.blocks.set('2,0,0', 'crafting_table');
  let now = 100;
  const registry = new TargetRegistry(one.bot, () => now, 10);
  const entry = registry.observe(targetQuerySchema.parse({ type: 'observe_targets', names: ['crafting_table'] })).targets[0]!;
  now = 111;
  assert.throws(() => registry.resolve(entry.ref, ['block']), /过期/);
  one.bot.game.dimension = 'the_nether';
  assert.equal((await one.actions.execute(operate({ type: 'navigate', targetRef: ref, range: 2 }))).error?.code, 'STALE_TARGET_REF');
  one.actions.dispose(); two.actions.dispose();
});

test('placement rechecks occupancy, support and explicit held item before writing', async () => {
  const { actions, bot, blocks } = setup();
  let placed = 0; bot.placeBlock = async () => { placed++; };
  const target = observe(actions, { placements: true })[0]!;
  assert.equal((await actions.execute(operate({ type: 'place', targetRef: target.ref, item: 'crafting_table', face: 'up' }))).error?.code, 'HELD_ITEM_MISMATCH');
  bot.heldItem = { name: 'crafting_table' };
  blocks.set(`${target.position.x},-1,${target.position.z}`, 'air');
  assert.equal((await actions.execute(operate({ type: 'place', targetRef: target.ref, item: 'crafting_table', face: 'up' }))).error?.code, 'PLACEMENT_CHANGED');
  assert.equal(placed, 0); actions.dispose();
});

test('entity references track current position but reject recycled entity identities', async () => {
  const { bot, actions } = setup();
  bot.entities[7] = { id: 7, uuid: 'entity', name: 'item', position: new Vec3(2, 0, 0) };
  const ref = observe(actions, { entities: true })[0]!.ref;
  bot.entities[7].position = new Vec3(3, 0, 0);
  assert.equal(actions.observations.targets.resolve(ref, ['entity']).position.x, 3);
  bot.entities[7] = { ...bot.entities[7] };
  assert.throws(() => actions.observations.targets.resolve(ref, ['entity']), /已改变/);
  actions.dispose();
});

test('basic operation schemas reject raw coordinates, commands and invented parameters', () => {
  assert.equal(parseDecision(JSON.stringify({ kind: 'operations', goal: 'g', operations: [{ type: 'equip', item: 'crafting_table' }] })).ok, false);
  for (const operation of [{ type: 'dig', position: { x: 2, y: 0, z: 0 } }, { type: 'execute', code: 'anything' },
    { type: 'place', targetRef: 'invented', item: 'stone' }, { type: 'equip', item: 'stone', code: 'anything' }]) {
    assert.equal(actionSchema.safeParse(operate(operation as any)).success, false);
  }
});

function context(overrides: Partial<DecisionValidationContext> = {}): DecisionValidationContext {
  return { player: 'alice', isOwner: true, session: { player: 'alice', recent: [] },
    observation: { version: '1.21.1' } as any, availableSkills: buildSkillCards(), grounding: '',
    availableOperations: availableOperations('1.21.1'), limits: { maxPlanSteps: 4, maxPlanSeconds: 120, maxReplyChars: 300 }, ...overrides };
}
test('operation decisions enforce owner, task occupancy, version, capability and repeated failure rules', () => {
  const validator = new DecisionValidator();
  const operation: BasicOperation = { type: 'equip', item: 'crafting_table', destination: 'hand' };
  const decision = { kind: 'operations' as const, goal: 'g', operations: [operation] };
  const rejected = (ctx: DecisionValidationContext, code: string) => {
    const result = validator.compile(decision, ctx); assert.equal(result.kind, 'reject');
    if (result.kind === 'reject') assert.equal(result.code, code);
  };
  rejected(context({ isOwner: false }), 'PERMISSION_DENIED');
  rejected(context({ availableOperations: [] }), 'SKILL_UNAVAILABLE');
  rejected(context({ observation: { version: '1.20.4' } as any }), 'SKILL_UNAVAILABLE');
  rejected(context({ blockedCalls: [callKey('operate', operation)] }), 'REPEATED_FAILURE');
  rejected(context({ currentTask: { state: 'running' } as any }), 'TASK_OCCUPIED');
  assert.equal(validator.compile({ ...decision, replaceCurrent: true }, context({ currentTask: { state: 'running' } as any })).kind, 'task');
});

test('cancelling a native operation holds the shared lease and prevents subsequent queued operations', async () => {
  const { actions, bot, put } = setup(); put('crafting_table', 1);
  let release!: () => void, next = 0;
  bot.equip = () => new Promise<void>(resolve => { release = resolve; });
  bot.unequip = async () => { next++; };
  const controller = new ActionController(actions);
  const pending = controller.execute({ taskId: 't', planRevision: 1, step: { id: 's', actions: [
    operate({ type: 'equip', item: 'crafting_table', destination: 'hand' }), operate({ type: 'unequip', destination: 'hand' }),
  ] } });
  await tick(); controller.stop();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(actions.busy, true);
  release(); await tick();
  assert.equal(next, 0); assert.equal(actions.busy, false); actions.dispose();
});

test('native equip completion alone cannot confirm an equipment operation', async () => {
  const { actions, bot, put } = setup(); put('crafting_table', 1); bot.equip = async () => {};
  assert.equal((await actions.execute(operate({ type: 'equip', item: 'crafting_table', destination: 'hand' }))).error?.code, 'EQUIPMENT_UNCONFIRMED');
  actions.dispose();
});

test('wood to placed workbench to equipped pickaxe crosses model queries and sequential operation batches', async () => {
  const { actions, bot, put } = setup(); put('spruce_log', 3);
  const scheduler = new TaskScheduler(new ActionController(actions));
  let batch = 0, call = 0;
  const recipe = (item: string) => {
    const result = actions.query({ type: 'recipe_lookup', item, limit: 32 }) as any;
    return result.data.recipes.find((r: any) => r.ingredients.every((i: any) => ['spruce_log', 'spruce_planks', 'stick'].includes(i.item))).recipeRef as string;
  };
  const plankRef = recipe('spruce_planks'), tableRecipe = recipe('crafting_table'), stickRecipe = recipe('stick'), pickRecipe = recipe('wooden_pickaxe');
  const brain = new CompanionBrain(actions, { llm: { async complete(input) {
    call++;
    if (call % 2 === 1) return JSON.stringify({ kind: 'query', query: { type: 'observe_targets', ...(batch === 0 ? { placements: true, limit: 1 } : { names: ['crafting_table'] }) } });
    const target = JSON.parse(input.user).knowledge[0].result.data.targets[0];
    const operations = batch === 0 ? [
      { type: 'craft', item: 'spruce_planks', count: 12, recipeRef: plankRef },
      { type: 'craft', item: 'crafting_table', count: 1, recipeRef: tableRecipe },
      { type: 'equip', item: 'crafting_table', destination: 'hand' }, { type: 'place', targetRef: target.ref, item: 'crafting_table', face: 'up' },
    ] : [
      { type: 'craft', item: 'stick', count: 4, recipeRef: stickRecipe },
      { type: 'craft', item: 'wooden_pickaxe', count: 1, recipeRef: pickRecipe, tableRef: target.ref },
      { type: 'equip', item: 'wooden_pickaxe', destination: 'hand' },
    ];
    return JSON.stringify({ kind: 'operations', goal: '制作并装备木镐', operations });
  } } });
  // P2 is an operation gateway: the harness explicitly requests the next batch.
  // Automatic continuation of a persistent goal belongs to P3.
  for (batch = 0; batch < 2; batch++) {
    const outcome = await brain.decide({ trigger: 'player_message', player: { name: 'alice', isOwner: true },
      session: { player: 'alice', recent: [] }, message: { id: `m${batch}`, player: 'alice', text: '制作并装备木镐', receivedAt: Date.now() } });
    assert.equal(outcome.kind, 'task'); if (outcome.kind !== 'task') throw new Error('expected task');
    scheduler.submit(outcome.task); await scheduler.runUntilIdle();
    const snapshot = scheduler.get(outcome.task.id)!;
    assert.equal(snapshot.state, 'completed', JSON.stringify(snapshot.lastResult));
    const feedback = buildRunFeedback({ task: outcome.task, snapshot });
    assert.equal(feedback.verified, true);
    assert.ok(feedback.verifiedChanges.inventory.length > 0);
  }
  assert.equal(bot.heldItem.name, 'wooden_pickaxe');
  assert.equal(observe(actions, { names: ['crafting_table'] }).length, 1);
  actions.dispose();
});
