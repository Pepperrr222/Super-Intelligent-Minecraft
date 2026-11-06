import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SKILLS } from '../src/builtin-skills.js';
import { SkillRunner, createSkillContext } from '../src/skill-runtime.js';
import { SkillCatalog } from '../src/skills.js';
import { CompanionBrain } from '../src/brain.js';
import { PlanValidator } from '../src/planner.js';
import type { ActionPort, QueryOutcome } from '../src/task.js';
import type { Action, ActionResult } from '../src/schema.js';

type Point = { x: number; y: number; z: number };
type Entity = { id: number; name: string; username?: string; position: Point };
type Block = { name: string; position: Point };
type Recipe = {
  result: { id: number; name: string; count: number };
  delta: Array<{ id: number; name: string; count: number }>;
  requiresTable: boolean;
};

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const ok = (action: Action, data?: unknown): ActionResult => ({
  id: 'a', type: action.type, status: 'succeeded', startedAt: 0, finishedAt: 0, data,
});

class SimPort implements ActionPort {
  busy = false;
  position: Point = { x: 0, y: 64, z: 0 };
  inventory = new Map<string, number>();
  entities: Entity[] = [];
  blocks: Block[] = [];
  recipes: Recipe[] = [];
  recipesWithTable: Recipe[] | undefined;
  calls: Action[] = [];
  queries: unknown[] = [];
  noPosition = false;
  failQuery?: (input: unknown) => QueryOutcome | undefined;
  failNext?: (action: Action) => { status: ActionResult['status']; code: string } | undefined;
  onExecute?: (action: Action) => void;

  query(input: unknown): QueryOutcome {
    this.queries.push(input);
    const injected = this.failQuery?.(input);
    if (injected) return injected;
    const q = input as { type?: string; names?: string[]; radius?: number; limit?: number; position?: Point; table?: Point };
    if (q.type === 'snapshot') {
      return {
        status: 'succeeded',
        data: {
          ...(this.noPosition ? {} : { position: this.position }),
          inventory: [...this.inventory]
            .filter(([, count]) => count > 0)
            .map(([name, count]) => ({ name, count })),
          entities: this.entities,
        },
      };
    }
    if (q.type === 'find_blocks') {
      const names = new Set(q.names ?? []);
      const radius = q.radius ?? 16;
      const limit = q.limit ?? 32;
      return {
        status: 'succeeded',
        data: {
          scope: 'loaded_client_chunks',
          completeWorldSearch: false,
          blocks: this.blocks
            .filter(block => names.has(block.name))
            .filter(block => distance(block.position, this.position) <= radius)
            .slice(0, limit)
            .map(block => ({ known: true, name: block.name, position: block.position })),
        },
      };
    }
    if (q.type === 'inspect_block') {
      const block = this.blocks.find(candidate =>
        candidate.position.x === q.position?.x
        && candidate.position.y === q.position?.y
        && candidate.position.z === q.position?.z);
      return {
        status: 'succeeded',
        data: block
          ? { known: true, name: block.name, position: block.position }
          : { known: true, name: 'air', position: q.position },
      };
    }
    if (q.type === 'recipes') {
      return {
        status: 'succeeded',
        data: q.table && this.recipesWithTable ? this.recipesWithTable : this.recipes,
      };
    }
    return { status: 'failed', error: 'unsupported query' };
  }

  async execute(action: Action): Promise<ActionResult> {
    this.calls.push(action);
    const failure = this.failNext?.(action);
    if (failure) {
      return {
        id: 'a', type: action.type, status: failure.status, startedAt: 0, finishedAt: 0,
        error: { code: failure.code, message: failure.code },
      };
    }
    this.onExecute?.(action);
    switch (action.type) {
      case 'navigate':
        this.position = { ...action.position };
        return ok(action, { evidence: 'position_observed', position: this.position });
      case 'wait':
        return ok(action, { waitedMs: action.durationMs });
      case 'craft':
        return ok(action, { evidence: 'inventory_delta' });
      case 'toss':
        return ok(action, { evidence: 'inventory_delta', removed: action.count });
      default:
        return ok(action, {});
    }
  }

  stop(): void {}
}

const runner = new SkillRunner(DEFAULT_SKILLS);
const run = <O = unknown>(
  port: SimPort,
  id: string,
  params: unknown,
  options: { signal?: AbortSignal; player?: string } = {},
) => runner.run<unknown, O>(id, params, createSkillContext(port, {
  signal: options.signal ?? new AbortController().signal,
  ...(options.player ? { player: options.player } : {}),
}));

/* -------------------------------------------------------------------------- */
/* navigate_to                                                                */
/* -------------------------------------------------------------------------- */

test('navigate_to reaches the target and confirms the final position', async () => {
  const port = new SimPort();
  const result = await run<{ navigated: boolean; distanceAfter: number | null }>(
    port, 'navigate_to', { x: 3, y: 64, z: 4, range: 1 },
  );

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(port.calls.map(action => action.type), ['navigate']);
  assert.equal(result.output?.navigated, true);
  assert.equal(result.output?.distanceAfter, 0);
});

test('navigate_to skips movement when already in range', async () => {
  const port = new SimPort();
  port.position = { x: 3, y: 64, z: 4 };
  const result = await run<{ navigated: boolean }>(port, 'navigate_to', { x: 3, y: 64, z: 4, range: 2 });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output?.navigated, false);
  assert.deepEqual(port.calls, []);
});

test('navigate_to is blocked when the current position cannot be observed', async () => {
  const port = new SimPort();
  port.noPosition = true;
  const result = await run(port, 'navigate_to', { x: 3, y: 64, z: 4 });

  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'POSITION_UNOBSERVED');
  assert.deepEqual(port.calls, []);
});

test('navigate_to reports the native path failure', async () => {
  const port = new SimPort();
  port.failNext = action => action.type === 'navigate'
    ? { status: 'failed', code: 'GOAL_NOT_REACHED' }
    : undefined;
  const result = await run(port, 'navigate_to', { x: 10, y: 64, z: 10, range: 1 });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'GOAL_NOT_REACHED');
  assert.deepEqual(port.calls.map(action => action.type), ['navigate']);
});

test('navigate_to cancellation during movement does not confirm arrival', async () => {
  const abort = new AbortController();
  const port = new SimPort();
  port.onExecute = action => { if (action.type === 'navigate') abort.abort(); };
  const result = await run(port, 'navigate_to', { x: 5, y: 64, z: 5, range: 1 }, { signal: abort.signal });

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(port.calls.map(action => action.type), ['navigate']);
});

/* -------------------------------------------------------------------------- */
/* collect_drops                                                              */
/* -------------------------------------------------------------------------- */

test('collect_drops approaches each observed drop and verifies inventory gains', async () => {
  const port = new SimPort();
  port.entities = [
    { id: 1, name: 'item', position: { x: 2, y: 64, z: 0 } },
    { id: 2, name: 'item', position: { x: 4, y: 64, z: 0 } },
  ];
  port.onExecute = action => {
    if (action.type !== 'wait') return;
    const index = port.entities.findIndex(entity => distance(entity.position, port.position) <= 2);
    if (index < 0) return;
    port.entities.splice(index, 1);
    port.inventory.set('oak_log', (port.inventory.get('oak_log') ?? 0) + 1);
  };
  const result = await run<{ collected: number; approached: number }>(
    port, 'collect_drops', { item: 'oak_log', count: 2, radius: 8, maxDrops: 4 },
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output?.collected, 2);
  assert.equal(result.output?.approached, 2);
  assert.deepEqual(port.calls.map(action => action.type), ['navigate', 'wait', 'navigate', 'wait']);
});

test('collect_drops is blocked when no drops are observed', async () => {
  const port = new SimPort();
  const result = await run(port, 'collect_drops', { item: 'oak_log' });

  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'NO_DROPS_OBSERVED');
  assert.deepEqual(port.calls, []);
});

test('collect_drops reports partial when the drop is never picked up', async () => {
  const port = new SimPort();
  port.entities = [{ id: 1, name: 'item', position: { x: 2, y: 64, z: 0 } }];
  const result = await run<{ collected: number }>(port, 'collect_drops', { item: 'oak_log', count: 1 });

  assert.equal(result.status, 'partial');
  assert.equal(result.error?.code, 'PICKUP_UNCONFIRMED');
  assert.equal(result.output?.collected, 0);
});

test('collect_drops retries a drop that was still falling when first approached', async () => {
  const port = new SimPort();
  port.entities = [{ id: 1, name: 'item', position: { x: 2, y: 66, z: 0 } }];
  port.failNext = action => action.type === 'navigate' && action.position.y >= 66
    ? { status: 'failed', code: 'GOAL_NOT_REACHED' }
    : undefined;
  port.onExecute = action => {
    if (action.type !== 'wait') return;
    const drop = port.entities[0];
    if (!drop) return;
    if (drop.position.y > 64) {
      drop.position.y = 64;
      return;
    }
    if (distance(drop.position, port.position) <= 2) {
      port.entities.splice(0, 1);
      port.inventory.set('oak_log', 1);
    }
  };

  const result = await run<{ collected: number; approached: number; unreachable: number }>(
    port, 'collect_drops', { item: 'oak_log', count: 1, radius: 8, maxDrops: 2 },
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output?.collected, 1);
  assert.equal(result.output?.approached, 1);
  assert.equal(result.output?.unreachable, 1);
  assert.deepEqual(port.calls.map(action => action.type), ['navigate', 'wait', 'navigate', 'wait']);
});

test('collect_drops cancellation during approach stops the loop', async () => {
  const abort = new AbortController();
  const port = new SimPort();
  port.entities = [{ id: 1, name: 'item', position: { x: 2, y: 64, z: 0 } }];
  port.onExecute = action => { if (action.type === 'navigate') abort.abort(); };
  const result = await run(port, 'collect_drops', { item: 'oak_log' }, { signal: abort.signal });

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(port.calls.map(action => action.type), ['navigate']);
});

/* -------------------------------------------------------------------------- */
/* find_resource                                                              */
/* -------------------------------------------------------------------------- */

test('find_resource reports observation failure without inventing candidates', async () => {
  const port = new SimPort();
  port.failQuery = input => (input as { type?: string }).type === 'find_blocks'
    ? { status: 'failed', error: 'observation unavailable' }
    : undefined;
  const result = await run(port, 'find_resource', { names: ['stone'] });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'OBSERVATION_UNAVAILABLE');
});

test('find_resource refuses to run after cancellation', async () => {
  const port = new SimPort();
  const abort = new AbortController();
  abort.abort('stop');
  const result = await run(port, 'find_resource', { names: ['stone'] }, { signal: abort.signal });

  assert.equal(result.status, 'cancelled');
  assert.equal(port.queries.length, 0);
});

/* -------------------------------------------------------------------------- */
/* craft_item                                                                 */
/* -------------------------------------------------------------------------- */

const planksRecipe: Recipe = {
  result: { id: 5, name: 'oak_planks', count: 4 },
  delta: [
    { id: 1, name: 'oak_log', count: -1 },
    { id: 5, name: 'oak_planks', count: 4 },
  ],
  requiresTable: false,
};

function craftEffects(port: SimPort) {
  return (action: Action) => {
    if (action.type !== 'craft') return;
    port.inventory.set('oak_log', (port.inventory.get('oak_log') ?? 0) - action.repetitions);
    port.inventory.set('oak_planks', (port.inventory.get('oak_planks') ?? 0) + 4 * action.repetitions);
  };
}

test('craft_item computes repetitions, checks materials and verifies output', async () => {
  const port = new SimPort();
  port.recipes = [planksRecipe];
  port.inventory.set('oak_log', 10);
  port.onExecute = craftEffects(port);
  const result = await run<{ crafted: number; repetitions: number; resultPerCraft: number }>(
    port, 'craft_item', { item: 'oak_planks', count: 5 },
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output?.crafted, 8);
  assert.equal(result.output?.repetitions, 2);
  assert.equal(result.output?.resultPerCraft, 4);
  assert.deepEqual(port.calls.map(action => action.type), ['craft']);
});

test('craft_item uses the first recipe, matching the craft action', async () => {
  const port = new SimPort();
  const largerAlternative: Recipe = {
    result: { id: 5, name: 'oak_planks', count: 6 },
    delta: [
      { id: 2, name: 'birch_log', count: -1 },
      { id: 5, name: 'oak_planks', count: 6 },
    ],
    requiresTable: false,
  };
  port.recipes = [planksRecipe, largerAlternative];
  port.inventory.set('oak_log', 10);
  port.inventory.set('birch_log', 10);
  port.onExecute = craftEffects(port);
  const result = await run<{ resultPerCraft: number; ingredients: Array<{ name: string }> }>(
    port, 'craft_item', { item: 'oak_planks', count: 5 },
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output?.resultPerCraft, 4);
  assert.equal(result.output?.ingredients[0]?.name, 'oak_log');
  assert.deepEqual(port.calls.map(action => action.type), ['craft']);
});

test('craft_item blocks before crafting when materials are insufficient', async () => {
  const port = new SimPort();
  port.recipes = [planksRecipe];
  port.inventory.set('oak_log', 1);
  const result = await run(port, 'craft_item', { item: 'oak_planks', count: 5 });

  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'INSUFFICIENT_MATERIALS');
  assert.deepEqual(port.calls, []);
});

test('craft_item is blocked when no recipe or workbench is available', async () => {
  const port = new SimPort();
  const result = await run(port, 'craft_item', { item: 'oak_planks', count: 4 });

  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'NO_CRAFTABLE_RECIPE');
  assert.deepEqual(port.calls, []);
});

test('craft_item finds a nearby workbench for table recipes', async () => {
  const port = new SimPort();
  port.recipesWithTable = [{ ...planksRecipe, requiresTable: true }];
  port.blocks = [{ name: 'crafting_table', position: { x: 2, y: 64, z: 0 } }];
  port.inventory.set('oak_log', 10);
  port.onExecute = craftEffects(port);
  const result = await run<{ table?: Point; crafted: number }>(
    port, 'craft_item', { item: 'oak_planks', count: 1 },
  );

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output?.table, { x: 2, y: 64, z: 0 });
  assert.equal(result.output?.crafted, 4);
  assert.deepEqual(port.calls.map(action => action.type), ['navigate', 'craft']);
});

test('craft_item cancellation during crafting is not reported as success', async () => {
  const abort = new AbortController();
  const port = new SimPort();
  port.recipes = [planksRecipe];
  port.inventory.set('oak_log', 10);
  port.onExecute = action => {
    craftEffects(port)(action);
    if (action.type === 'craft') abort.abort();
  };
  const result = await run(port, 'craft_item', { item: 'oak_planks', count: 4 }, { signal: abort.signal });

  assert.equal(result.status, 'cancelled');
});

/* -------------------------------------------------------------------------- */
/* store_items                                                                */
/* -------------------------------------------------------------------------- */

test('store_items is blocked when the inventory is insufficient', async () => {
  const port = new SimPort();
  port.inventory.set('oak_log', 2);
  const result = await run(port, 'store_items', {
    container: { x: 0, y: 64, z: 0 }, item: 'oak_log', count: 3,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'INSUFFICIENT_ITEMS');
  assert.deepEqual(port.calls, []);
});

test('store_items cancellation after a transfer request is not reported as success', async () => {
  const abort = new AbortController();
  const port = new SimPort();
  port.inventory.set('oak_log', 10);
  port.onExecute = action => { if (action.type === 'container_transfer') abort.abort(); };
  const result = await run(port, 'store_items', {
    container: { x: 0, y: 64, z: 0 }, item: 'oak_log', count: 3,
  }, { signal: abort.signal });

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(port.calls.map(action => action.type), ['container_inspect', 'container_transfer']);
});

/* -------------------------------------------------------------------------- */
/* deliver_to_player                                                          */
/* -------------------------------------------------------------------------- */

test('deliver_to_player approaches the player and verifies the toss removed items', async () => {
  const port = new SimPort();
  port.inventory.set('oak_log', 5);
  port.entities = [{ id: 7, name: 'player', username: 'alice', position: { x: 6, y: 64, z: 0 } }];
  port.onExecute = action => {
    if (action.type === 'toss') {
      port.inventory.set('oak_log', (port.inventory.get('oak_log') ?? 0) - action.count);
    }
  };
  const result = await run<{ tossed: number | null; receipt: string; playerDistance: number | null }>(
    port, 'deliver_to_player', { item: 'oak_log', count: 3 }, { player: 'alice' },
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output?.tossed, 3);
  assert.equal(result.output?.receipt, 'unverified');
  assert.equal(result.output?.playerDistance, 0);
  assert.deepEqual(port.calls.map(action => action.type), ['navigate', 'toss']);
});

test('deliver_to_player is blocked when the player is not observed', async () => {
  const port = new SimPort();
  port.inventory.set('oak_log', 5);
  const result = await run(port, 'deliver_to_player', { item: 'oak_log', count: 3 }, { player: 'alice' });

  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'PLAYER_NOT_OBSERVED');
  assert.deepEqual(port.calls, []);
});

test('deliver_to_player is blocked when the inventory is insufficient', async () => {
  const port = new SimPort();
  port.inventory.set('oak_log', 2);
  port.entities = [{ id: 7, name: 'player', username: 'alice', position: { x: 2, y: 64, z: 0 } }];
  const result = await run(port, 'deliver_to_player', { item: 'oak_log', count: 3 }, { player: 'alice' });

  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'INSUFFICIENT_ITEMS');
  assert.deepEqual(port.calls, []);
});

test('deliver_to_player cancellation after tossing leaves the result unverified', async () => {
  const abort = new AbortController();
  const port = new SimPort();
  port.inventory.set('oak_log', 5);
  port.entities = [{ id: 7, name: 'player', username: 'alice', position: { x: 2, y: 64, z: 0 } }];
  port.onExecute = action => {
    if (action.type === 'toss') {
      port.inventory.set('oak_log', 2);
      abort.abort();
    }
  };
  const result = await run<{ tossed: number | null; inventoryAfter: number | null }>(
    port, 'deliver_to_player', { item: 'oak_log', count: 3 }, { player: 'alice', signal: abort.signal },
  );

  assert.equal(result.status, 'cancelled');
  assert.equal(result.output?.tossed, null);
  assert.equal(result.output?.inventoryAfter, null);
  assert.ok(result.partialEffects.some(effect => effect.includes('无法确认背包变化')));
});

test('deliver_to_player cancellation before tossing reports zero moved items', async () => {
  const abort = new AbortController();
  const port = new SimPort();
  port.inventory.set('oak_log', 5);
  port.entities = [{ id: 7, name: 'player', username: 'alice', position: { x: 6, y: 64, z: 0 } }];
  port.onExecute = action => { if (action.type === 'navigate') abort.abort(); };
  const result = await run<{ tossed: number | null }>(
    port, 'deliver_to_player', { item: 'oak_log', count: 3 }, { player: 'alice', signal: abort.signal },
  );

  assert.equal(result.status, 'cancelled');
  assert.equal(result.output?.tossed, 0);
});

/* -------------------------------------------------------------------------- */
/* Catalog / brain / planner integration                                      */
/* -------------------------------------------------------------------------- */

test('catalog registers the first-batch dynamic skills and validates params', () => {
  const catalog = new SkillCatalog();
  for (const id of ['navigate_to', 'collect_drops', 'craft_item', 'deliver_to_player', 'gather_wood', 'find_resource', 'store_items']) {
    assert.ok(catalog.get(id), `missing catalog skill ${id}`);
  }
  const crafted = catalog.compile('craft_item', { item: 'oak_planks', count: 4 }, { player: 'alice' });
  assert.equal(crafted.kind, 'dynamic');
  if (crafted.kind === 'dynamic') assert.equal(crafted.skill.id, 'craft_item');
  assert.equal(catalog.compile('craft_item', { item: '' }, { player: 'alice' }).kind, 'clarify');
});

test('brain carries a validated skill into a task without a confirmation round', async () => {
  const brain = new CompanionBrain({ query: () => ({ status: 'succeeded', data: { inventory: [], entities: [] } }) });
  const output = await brain.handle({
    message: { id: 'm1', player: 'alice', text: '做木板', receivedAt: Date.now() },
    intent: { kind: 'skill', skill: 'craft_item', params: { item: 'oak_planks', count: 4 } },
    session: { player: 'alice', recent: [] },
  });

  assert.equal(output.kind, 'task');
  if (output.kind === 'task') {
    assert.equal(output.confirmation, undefined);
    assert.equal(output.task.steps[0]?.skill?.id, 'craft_item');
  }
});

test('planner grounds craft_item table coordinates when provided', () => {
  const snapshot = { position: { x: 0, y: 64, z: 0 }, inventory: [], entities: [] };
  const validator = new PlanValidator();
  const plan = {
    id: 'p', goalId: 'g', revision: 0,
    nodes: [{
      id: 'a', skill: 'craft_item',
      params: { item: 'oak_planks', count: 4, table: { x: 2, y: 64, z: 0 } },
      preconditions: [], postconditions: [], idempotent: false,
    }],
    edges: [], milestones: [], assumptions: [],
    budget: { maxSteps: 2, maxSeconds: 60 },
  };
  assert.ok('task' in validator.compile(plan, { player: 'alice', snapshot }, '用坐标 2 64 0 的工作台做木板'));
  assert.ok('error' in validator.compile(plan, { player: 'alice', snapshot }, '做木板'));
});
