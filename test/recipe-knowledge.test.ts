import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fixture, tick } from './fixtures.js';
import { BotRecipeProvider, recipeReference, type RecipeProvider, type RecipeRecord } from '../src/recipes.js';
import { expandRequirements } from '../src/requirements.js';
import { requirementsParamsSchema } from '../src/schema.js';
import { ActionController } from '../src/controller.js';
import { TaskScheduler } from '../src/scheduler.js';
import { CompanionBrain } from '../src/brain.js';

const require = createRequire(import.meta.url);
const native = createRequire(require.resolve('mineflayer'));
function setup() {
  const setup = fixture('1.21.1');
  const { bot, slots } = setup;
  const { Recipe } = native('prismarine-recipe')(bot.registry);
  bot.recipesAll = (id: number, metadata: number | null, table: unknown) => Recipe.find(id, metadata)
    .filter((recipe: any) => !recipe.requiresTable || table);
  const put = (name: string, count: number) => {
    let slot = slots.findIndex(item => item?.name === name);
    if (slot < 0) slot = slots.findIndex((item, i) => i >= 9 && i < 45 && !item);
    slots[slot] = count > 0 ? { name, count, slot, type: bot.registry.itemsByName[name].id, metadata: 0 } as any : null;
  };
  return { ...setup, put, provider: new BotRecipeProvider(bot) };
}
const expand = (provider: RecipeProvider, inventory: Array<{ item: string; count: number }>, params: unknown) =>
  expandRequirements(provider, requirementsParamsSchema.parse(params), inventory);

test('theoretical recipes include unavailable materials and facilities, with pagination and positive inputs', () => {
  const { actions, provider } = setup();
  const query: any = actions.query({ type: 'recipe_lookup', item: 'wooden_pickaxe', limit: 1 });
  assert.equal(query.status, 'succeeded');
  assert.equal(query.data.recipes[0].facility, 'crafting_table');
  assert.equal(query.data.serverRulesVerified, false);
  assert.equal(query.data.nextOffset, 1);
  const next: any = actions.query({ type: 'recipe_lookup', item: 'wooden_pickaxe', offset: 1, limit: 1 });
  assert.notEqual(next.data.recipes[0].recipeRef, query.data.recipes[0].recipeRef);
  assert.deepEqual(provider.lookup('spruce_planks')[0]!.ingredients, [{ item: 'spruce_log', count: 1 }]);
  actions.dispose();
});

test('recipe references bind item, native recipe, version and revision', () => {
  const { actions, provider, bot } = setup();
  const selected = provider.lookup('spruce_planks')[0]!;
  assert.equal(provider.resolve('spruce_planks', selected.recipeRef).record.recipeRef, selected.recipeRef);
  assert.throws(() => provider.resolve('oak_planks', selected.recipeRef), /配方引用/);
  bot.version = 'different-version';
  assert.throws(() => provider.resolve('spruce_planks', selected.recipeRef), /配方引用/);
  assert.notEqual(recipeReference(selected), recipeReference({ ...selected, revision: 'new' }));
  actions.dispose();
});

test('evaluation reports full-batch ingredients and labels facility assumptions', () => {
  const { actions, provider, put } = setup();
  put('spruce_log', 1);
  const selected = provider.lookup('spruce_planks')[0]!;
  const query: any = actions.query({ type: 'recipe_evaluate', item: 'spruce_planks', recipeRef: selected.recipeRef, count: 5 });
  assert.equal(query.data.batches, 2);
  assert.equal(query.data.ingredients[0].missing, 1);
  assert.equal(query.data.craftable, false);
  const pick = provider.lookup('wooden_pickaxe')[0]!;
  const table: any = actions.query({ type: 'recipe_evaluate', item: 'wooden_pickaxe', recipeRef: pick.recipeRef, count: 1, facilities: ['crafting_table'] });
  assert.equal(table.data.facilityObserved, false);
  assert.deepEqual(table.data.assumedFacilities, ['crafting_table']);
  actions.dispose();
});

test('recursive expansion selects available spruce routes and conserves inputs and batch leftovers', () => {
  const { actions, provider } = setup();
  const result = expand(provider, [{ item: 'spruce_log', count: 3 }], { goals: [{ item: 'wooden_pickaxe', count: 1 }] });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.missing, []);
  assert.equal(result.executable, false);
  assert.equal(result.operations.filter(op => op.kind === 'place_facility').length, 1);
  assert.deepEqual(result.inventoryRemaining, [{ item: 'spruce_planks', count: 3 }, { item: 'stick', count: 2 }]);
  for (const op of result.operations) if (op.kind === 'craft') {
    const selected = provider.resolve(op.item, op.recipeRef).record;
    assert.ok(selected.ingredients.every(input => !input.item.includes('cherry') && input.item !== 'bamboo'));
  }
  actions.dispose();
});

test('multiple tool goals share materials and reserve one reusable crafting table', () => {
  const { actions, provider } = setup();
  const goals = ['wooden_pickaxe', 'wooden_axe', 'wooden_shovel', 'wooden_sword', 'wooden_hoe'].map(item => ({ item, count: 1 }));
  const result = expand(provider, [{ item: 'spruce_log', count: 6 }], { goals });
  assert.equal(result.status, 'resolved');
  assert.equal(result.operations.filter(op => op.kind === 'place_facility').length, 1);
  assert.ok(result.inventoryRemaining.every(item => item.count > 0));
  assert.deepEqual(result.inventoryRemaining, [{ item: 'spruce_planks', count: 3 }, { item: 'stick', count: 3 }]);
  const insufficient = expand(provider, [{ item: 'spruce_log', count: 1 }], { goals, maxAlternatives: 1 });
  assert.notEqual(insufficient.status, 'resolved');
  assert.ok(insufficient.missing.length > 0);
  // Replay resolved dependency operations against an independent material ledger.
  // A resolved plan must never spend nonexistent inputs, across supported woods.
  for (const wood of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry']) {
    const initial = [{ item: `${wood}_log`, count: 6 }];
    const expanded = expand(provider, initial, { goals });
    assert.equal(expanded.status, 'resolved', wood);
    const actual = new Map(initial.map(entry => [entry.item, entry.count]));
    for (const operation of expanded.operations) {
      if (operation.kind === 'place_facility') {
        assert.ok((actual.get('crafting_table') ?? 0) >= 1);
        actual.set('crafting_table', actual.get('crafting_table')! - 1);
        continue;
      }
      const record = provider.resolve(operation.item, operation.recipeRef).record;
      for (const ingredient of record.ingredients) {
        const available = actual.get(ingredient.item) ?? 0;
        const materialCost: number = ingredient.count * operation.batches;
        assert.ok(available >= materialCost, `${wood}: ${ingredient.item}`);
        actual.set(ingredient.item, available - materialCost);
      }
      actual.set(operation.item, (actual.get(operation.item) ?? 0) + operation.outputCount);
    }
    for (const goal of goals) assert.ok((actual.get(goal.item) ?? 0) >= goal.count);
  }
  actions.dispose();
});

test('total versus additional quantities and existing facilities have distinct semantics', () => {
  const { actions, provider } = setup();
  const inventory = [{ item: 'spruce_planks', count: 10 }, { item: 'spruce_log', count: 1 }];
  const total = expand(provider, inventory, { goals: [{ item: 'spruce_planks', count: 4 }] });
  assert.equal(total.operations.length, 0);
  const additional = expand(provider, inventory, { goals: [{ item: 'spruce_planks', count: 4 }], mode: 'additional' });
  assert.equal(additional.operations.length, 1);
  assert.deepEqual(additional.reservedExisting, [{ item: 'spruce_planks', count: 10 }]);
  const existing = expand(provider, [{ item: 'spruce_planks', count: 3 }, { item: 'stick', count: 2 }], {
    goals: [{ item: 'wooden_pickaxe', count: 1 }], facilities: ['crafting_table'],
  });
  assert.equal(existing.status, 'resolved');
  assert.equal(existing.operations.length, 1);
  actions.dispose();
});

test('dependency cycles, depth, node limits and cancellation terminate explicitly', () => {
  const recipe = (item: string, ingredient: string): RecipeRecord => ({ recipeRef: item, source: 'test', version: 'v', revision: '1',
    kind: 'crafting', result: { item, count: 1 }, ingredients: [{ item: ingredient, count: 1 }], facility: 'inventory' });
  const provider: RecipeProvider = { source: 'test', version: 'v', revision: '1', lookup: item => [recipe(item, item === 'a' ? 'b' : 'a')] };
  const result = expand(provider, [], { goals: [{ item: 'a', count: 1 }] });
  assert.equal(result.status, 'needs_resources');
  assert.equal(result.missing[0]?.reason, 'cycle');
  const chain: RecipeProvider = { ...provider, lookup: item => item === 'c' ? [] : [recipe(item, item === 'a' ? 'b' : 'c')] };
  assert.equal(expand(chain, [], { goals: [{ item: 'a', count: 1 }], maxDepth: 1 }).status, 'incomplete');
  assert.equal(expand(provider, [], { goals: [{ item: 'a', count: 1 }], maxNodes: 1 }).status, 'incomplete');
  assert.throws(() => expandRequirements(provider, requirementsParamsSchema.parse({ goals: [{ item: 'a', count: 1 }] }), [], () => { throw new Error('cancelled'); }), /cancelled/);
});

test('selected recipe execution rejects stale references and insufficient full batches before any craft', async () => {
  const { actions, provider, bot, put } = setup();
  put('spruce_log', 1);
  let crafts = 0;
  bot.craft = async () => { crafts++; };
  const recipeRef = provider.lookup('spruce_planks')[0]!.recipeRef;
  assert.equal((await actions.execute({ type: 'craft', item: 'spruce_planks', recipeRef: '0'.repeat(64), repetitions: 1 })).error?.code, 'STALE_RECIPE');
  assert.equal((await actions.execute({ type: 'craft', item: 'spruce_planks', recipeRef, repetitions: 2 })).error?.code, 'INSUFFICIENT_MATERIALS');
  assert.equal(crafts, 0);
  actions.dispose();
});

test('both craft entry points use the exact recipe and reconcile inventory after native completion', async () => {
  for (const type of ['craft', 'craft_output']) {
    const { actions, provider, bot, put } = setup();
    put('spruce_log', 1);
    const recipeRef = provider.lookup('spruce_planks')[0]!.recipeRef;
    let crafts = 0;
    bot.recipesFor = () => assert.fail('explicit selection must never pick recipesFor()[0]');
    bot.craft = async (recipe: any) => { crafts++; assert.equal(recipe.result.id, bot.registry.itemsByName.spruce_planks.id); };
    bot._syncWindow = async () => { put('spruce_log', 0); put('spruce_planks', 4); };
    const result = await actions.execute({ type, item: 'spruce_planks', recipeRef, ...(type === 'craft' ? { repetitions: 1 } : { outputCount: 3 }) });
    assert.equal(result.status, 'succeeded');
    assert.equal((result.data as any).gained, 4);
    assert.equal((result.data as any).reconciled, true);
    assert.equal((result.data as any).recipeRef, recipeRef);
    assert.equal(crafts, 1);
    actions.dispose();
  }
});

test('craft mismatch preserves observed effects through action and dynamic skill without retries', async () => {
  const { actions, provider, bot, put } = setup();
  put('spruce_log', 1);
  const recipeRef = provider.lookup('spruce_planks')[0]!.recipeRef;
  let crafts = 0;
  bot.craft = async () => { crafts++; put('spruce_log', 0); put('spruce_planks', 2); };
  bot._syncWindow = async () => {};
  const controller = new ActionController(actions);
  const result = await controller.execute({ taskId: 't', planRevision: 1,
    step: { id: 'craft', actions: [], skill: { id: 'craft_item', params: { item: 'spruce_planks', count: 4, recipeRef } } } });
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'INVENTORY_MISMATCH');
  assert.equal((result.data as any).output.gained, 2);
  assert.equal((result.data as any).output.apiComplete, true);
  assert.equal(crafts, 1);
  actions.dispose();
});

test('cancellation during inventory reconciliation retains the native lease and blocks later writes', async () => {
  const { actions, provider, bot, put } = setup();
  put('spruce_log', 1);
  const recipeRef = provider.lookup('spruce_planks')[0]!.recipeRef;
  bot.craft = async () => {};
  let release!: () => void;
  bot._syncWindow = () => new Promise<void>(resolve => { release = resolve; });
  const result = actions.execute({ type: 'craft', item: 'spruce_planks', recipeRef, repetitions: 1 });
  await tick(); actions.stop();
  assert.equal((await result).status, 'cancelled');
  assert.equal(actions.busy, true);
  assert.equal((await actions.execute({ type: 'wait', durationMs: 1 })).status, 'busy');
  release(); await tick();
  assert.equal(actions.busy, false);
  actions.dispose();
});

test('knowledge queries feed a selected recipe through brain, scheduler, skill, action and final inventory', async () => {
  const { actions, bot, put } = setup();
  put('spruce_log', 1);
  let turn = 0;
  let selected: string | undefined;
  const brain = new CompanionBrain(actions, { llm: { async complete(input) {
    turn++;
    if (turn === 1) return JSON.stringify({ kind: 'query', query: { type: 'recipe_lookup', item: 'spruce_planks', limit: 1 } });
    const context = JSON.parse(input.user);
    selected = context.knowledge[0].result.data.recipes[0].recipeRef;
    return JSON.stringify({ kind: 'skill', skill: 'craft_item', params: { item: 'spruce_planks', count: 4, recipeRef: selected } });
  } } });
  const result = await brain.decide({ trigger: 'player_message', player: { name: 'alice', isOwner: true },
    message: { id: 'm', player: 'alice', text: '制作4个云杉木板', receivedAt: Date.now() }, session: { player: 'alice', recent: [] } });
  assert.equal(result.kind, 'task');
  if (result.kind !== 'task') throw new Error('expected task');
  const scheduler = new TaskScheduler(new ActionController(actions));
  bot.craft = async () => { put('spruce_log', 0); put('spruce_planks', 4); };
  bot._syncWindow = async () => {};
  scheduler.submit(result.task);
  await scheduler.runUntilIdle();
  assert.equal(scheduler.get(result.task.id)?.state, 'completed');
  const output = scheduler.get(result.task.id)?.lastResult?.data as any;
  assert.equal(output.recipeRef, selected);
  assert.equal(output.crafted, 4);
  actions.dispose();
});
