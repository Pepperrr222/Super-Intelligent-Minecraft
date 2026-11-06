import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ActionController } from '../src/controller.js';
import { DEFAULT_SKILLS } from '../src/builtin-skills.js';
import {
  SkillRegistry,
  SkillRunner,
  createSkillContext,
} from '../src/skill-runtime.js';
import type { ActionPort, ControllerCommand, QueryOutcome } from '../src/task.js';
import type { ActionResult } from '../src/schema.js';

function succeeded(type = 'wait'): ActionResult {
  return { id: 'result', type, status: 'succeeded', startedAt: 0, finishedAt: 0,
    data: { evidence: 'client_observed' } };
}

class FakeActions implements ActionPort {
  busy = false;
  calls: unknown[] = [];
  queryOutcome: QueryOutcome = { status: 'succeeded', data: { value: 42 } };

  async execute(action: unknown): Promise<ActionResult> {
    this.calls.push(action);
    return succeeded((action as { type?: string }).type ?? 'wait');
  }

  query(): QueryOutcome {
    return this.queryOutcome;
  }

  stop(): void {}
}

function sampleRegistry(calls: string[]): SkillRegistry {
  return new SkillRegistry().register({
    id: 'sample',
    description: 'test-only skill',
    inputSchema: z.object({ count: z.number().int().min(1) }).strict(),
    supportedVersions: ['1.21.1'],
    risk: 'low',
    requiredCapabilities: [],
    idempotent: true,
    async run(input, context) {
      calls.push('run');
      context.report('observing');
      const observation = context.query<{ value: number }>({ type: 'snapshot', radius: 1 });
      const action = await context.execute({ type: 'wait', durationMs: 1 });
      return {
        status: 'succeeded',
        output: { count: input.count, observed: observation.value, action: action.type },
      };
    },
  });
}

test('runner validates input and normalises observation/action evidence', async () => {
  const actions = new FakeActions();
  const calls: string[] = [];
  const runner = new SkillRunner(sampleRegistry(calls));
  const context = createSkillContext(actions, { signal: new AbortController().signal });
  const result = await runner.run<{ count: number }, { count: number; observed: number; action: string }>(
    'sample',
    { count: 3 },
    context,
  );

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, { count: 3, observed: 42, action: 'wait' });
  assert.equal(result.progress[0]?.message, 'observing');
  assert.deepEqual(result.evidence.map(item => item.kind), ['observation', 'action']);
  assert.equal(actions.calls.length, 1);
});

test('invalid skill input fails before running the skill', async () => {
  const calls: string[] = [];
  const runner = new SkillRunner(sampleRegistry(calls));
  const result = await runner.run('sample', { count: 0 }, createSkillContext(new FakeActions(), {
    signal: new AbortController().signal,
  }));

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'INVALID_SKILL_INPUT');
  assert.deepEqual(calls, []);
});

test('unknown skill fails without touching the action port', async () => {
  const actions = new FakeActions();
  const runner = new SkillRunner(new SkillRegistry());
  const result = await runner.run('missing', {}, createSkillContext(actions, {
    signal: new AbortController().signal,
  }));

  assert.equal(result.error?.code, 'UNKNOWN_SKILL');
  assert.equal(actions.calls.length, 0);
});

test('pre-aborted context returns cancelled without running the skill', async () => {
  const abort = new AbortController();
  abort.abort(new Error('player stopped'));
  const calls: string[] = [];
  const runner = new SkillRunner(sampleRegistry(calls));
  const result = await runner.run('sample', { count: 1 }, createSkillContext(new FakeActions(), {
    signal: abort.signal,
  }));

  assert.equal(result.status, 'cancelled');
  assert.equal(result.error?.code, 'CANCELLED');
  assert.deepEqual(calls, []);
});

test('find_resource returns observed candidates without choosing one', async () => {
  const actions = new FakeActions();
  actions.queryOutcome = {
    status: 'succeeded',
    data: {
      blocks: [{ known: true, name: 'oak_log', position: { x: 1, y: 64, z: 2 } }],
      scope: 'loaded_client_chunks',
      completeWorldSearch: false,
    },
  };
  const runner = new SkillRunner(DEFAULT_SKILLS);
  const result = await runner.run<{ names: string[]; radius: number }, { blocks: Array<{ name?: string }> }>(
    'find_resource',
    { names: ['oak_log'], radius: 8 },
    createSkillContext(actions, {
    signal: new AbortController().signal,
  }));

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output?.blocks.length, 1);
  assert.equal(result.evidence[0]?.kind, 'observation');
});

class StoreActions implements ActionPort {
  busy = false;
  inventory = 5;
  container = 2;
  calls: string[] = [];
  moveContainer = true;

  async execute(action: unknown): Promise<ActionResult> {
    const typed = action as { type: string; count?: number };
    this.calls.push(typed.type);
    if (typed.type === 'container_inspect') {
      return {
        id: 'result', type: typed.type, status: 'succeeded', startedAt: 0, finishedAt: 0,
        data: { items: [{ slot: 0, item: { name: 'oak_log', count: this.container } }] },
      };
    }
    if (typed.type === 'container_transfer') {
      const count = typed.count ?? 0;
      this.inventory -= count;
      if (this.moveContainer) this.container += count;
      return { id: 'result', type: typed.type, status: 'succeeded', startedAt: 0, finishedAt: 0,
        data: { evidence: 'inventory_delta', delta: -count } };
    }
    return succeeded(typed.type);
  }

  query(): QueryOutcome {
    return {
      status: 'succeeded',
      data: { inventory: this.inventory > 0 ? [{ name: 'oak_log', count: this.inventory }] : [] },
    };
  }

  stop(): void {}
}

test('store_items verifies both inventory and container after depositing', async () => {
  const actions = new StoreActions();
  const runner = new SkillRunner(DEFAULT_SKILLS);
  const result = await runner.run('store_items', {
    container: { x: 0, y: 64, z: 0 },
    item: 'oak_log',
    count: 3,
  }, createSkillContext(actions, { signal: new AbortController().signal }));

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, {
    container: { x: 0, y: 64, z: 0 },
    item: 'oak_log',
    requested: 3,
    containerBefore: 2,
    containerAfter: 5,
    inventoryBefore: 5,
    inventoryAfter: 2,
  });
  assert.deepEqual(actions.calls, ['container_inspect', 'container_transfer', 'container_inspect']);
});

test('store_items is partial when the container does not change', async () => {
  const actions = new StoreActions();
  actions.moveContainer = false;
  const runner = new SkillRunner(DEFAULT_SKILLS);
  const result = await runner.run('store_items', {
    container: { x: 0, y: 64, z: 0 },
    item: 'oak_log',
    count: 3,
  }, createSkillContext(actions, { signal: new AbortController().signal }));

  assert.equal(result.status, 'partial');
  assert.equal(result.error?.code, 'TRANSFER_MISMATCH');
});

test('controller executes a registered skill with progress and output', async () => {
  const actions = new FakeActions();
  const calls: string[] = [];
  const controller = new ActionController(actions, sampleRegistry(calls));
  const command: ControllerCommand = {
    taskId: 'task',
    planRevision: 1,
    step: { id: 'step', actions: [], skill: { id: 'sample', params: { count: 2 } } },
  };
  const result = await controller.execute(command);

  assert.equal(result.status, 'ok');
  assert.equal(result.progress?.[0]?.message, 'observing');
  assert.deepEqual(result.data, {
    count: 2,
    observed: 42,
    action: 'wait',
    output: { count: 2, observed: 42, action: 'wait' },
    progress: result.progress,
    partialEffects: ['已完成动作: wait'],
  });
  assert.equal(actions.calls.length, 1);
});
