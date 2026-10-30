import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionController } from '../src/controller.js';
import type { ActionPort, ControllerCommand, QueryOutcome, TaskStep } from '../src/task.js';
import type { ActionResult } from '../src/schema.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function succeeded(type = 'wait', data: unknown = { evidence: 'client_observed' }): ActionResult {
  return { id: 'result', type, status: 'succeeded', startedAt: 0, finishedAt: 0, data };
}

function failed(code = 'ACTION_FAILED'): ActionResult {
  return { id: 'result', type: 'wait', status: 'failed', startedAt: 0, finishedAt: 0,
    error: { code, message: 'failed' } };
}

class FakeActions implements ActionPort {
  busy = false;
  calls: unknown[] = [];
  stops: string[] = [];
  responses: ActionResult[] = [];
  queryOutcome: QueryOutcome = { status: 'succeeded', data: { value: true } };

  async execute(action: unknown): Promise<ActionResult> {
    this.calls.push(action);
    return this.responses.shift() ?? succeeded();
  }

  query(): QueryOutcome {
    return this.queryOutcome;
  }

  stop(reason?: string): void {
    this.stops.push(reason ?? '');
  }
}

class BlockingActions extends FakeActions {
  override async execute(action: unknown, options?: { signal?: AbortSignal }): Promise<ActionResult> {
    this.calls.push(action);
    return new Promise(resolve => {
      const finish = () => resolve({
        id: 'result', type: 'wait', status: 'cancelled', startedAt: 0, finishedAt: 0,
        error: { code: 'CANCELLED', message: 'cancelled' },
      });
      if (options?.signal?.aborted) finish();
      else options?.signal?.addEventListener('abort', finish, { once: true });
    });
  }
}

function command(step: Partial<TaskStep> = {}, extra: Partial<ControllerCommand> = {}): ControllerCommand {
  return {
    taskId: 'task',
    planRevision: 1,
    step: { id: 'step', actions: [{ type: 'wait', durationMs: 1 }], ...step },
    ...extra,
  };
}

test('controller runs the step, verifies postconditions and reports evidence', async () => {
  const actions = new FakeActions();
  actions.responses = [
    succeeded('wait', { evidence: 'client_observed' }),
    succeeded('equip', { evidence: 'inventory_delta' }),
  ];
  const controller = new ActionController(actions);
  const result = await controller.execute(command({
    actions: [
      { type: 'wait', durationMs: 1 },
      { type: 'equip', item: 'stone', destination: 'hand' },
    ],
    postconditions: [{ kind: 'inventory_at_least', item: 'stone', count: 1 }],
  }));

  assert.equal(result.status, 'ok');
  assert.equal(result.evidence, 'step_verified');
  assert.equal(actions.calls.length, 2);
  assert.equal(result.partialEffects.length, 2);
  assert.deepEqual(result.data, { evidence: 'inventory_delta' });
});

test('precondition false blocks before any native action', async () => {
  const actions = new FakeActions();
  actions.queryOutcome = { status: 'succeeded', data: { value: false, observed: 0 } };
  const controller = new ActionController(actions);
  const result = await controller.execute(command({
    preconditions: [{ kind: 'inventory_at_least', item: 'stone', count: 1 }],
  }));

  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'PRECONDITION_FAILED');
  assert.equal(actions.calls.length, 0);
});

test('unknown precondition is blocked, not treated as success', async () => {
  const actions = new FakeActions();
  actions.queryOutcome = { status: 'failed', error: 'query failed' };
  const controller = new ActionController(actions);
  const result = await controller.execute(command({
    preconditions: [{ kind: 'health_at_least', health: 10 }],
  }));

  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'PRECONDITION_QUERY_FAILED');
  assert.equal(actions.calls.length, 0);
});

test('first failed action returns error and does not retry', async () => {
  const actions = new FakeActions();
  actions.responses = [failed('MISSING_ITEM')];
  const controller = new ActionController(actions);
  const result = await controller.execute(command());

  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, 'MISSING_ITEM');
  assert.equal(actions.calls.length, 1);
});

test('failure after a successful action is partial, not silently retried', async () => {
  const actions = new FakeActions();
  actions.responses = [succeeded(), failed('TIMEOUT')];
  const controller = new ActionController(actions);
  const result = await controller.execute(command({
    actions: [{ type: 'wait', durationMs: 1 }, { type: 'wait', durationMs: 1 }],
  }));

  assert.equal(result.status, 'partial');
  assert.equal(result.error?.code, 'TIMEOUT');
  assert.equal(actions.calls.length, 2);
});

test('busy is returned without queueing inside the controller', async () => {
  const actions = new FakeActions();
  actions.responses = [{
    id: 'result', type: 'wait', status: 'busy', startedAt: 0, finishedAt: 0,
    error: { code: 'BUSY', message: 'busy' },
  }];
  const controller = new ActionController(actions);
  const result = await controller.execute(command());

  assert.equal(result.status, 'busy');
  assert.equal(result.error?.code, 'BUSY');
  assert.equal(actions.calls.length, 1);
});

test('stop cancels the active step and keeps the controller busy until it settles', async () => {
  const actions = new BlockingActions();
  const controller = new ActionController(actions);
  const pending = controller.execute(command());
  await tick();
  assert.equal(controller.busy, true);
  controller.stop('test stop');
  const result = await pending;

  assert.equal(result.status, 'cancelled');
  assert.equal(actions.stops.includes('test stop'), true);
  assert.equal(controller.busy, false);
});

test('expired deadline times out before sending an action', async () => {
  const actions = new FakeActions();
  const controller = new ActionController(actions);
  const result = await controller.execute(command({}, { deadline: Date.now() - 1 }));

  assert.equal(result.status, 'timeout');
  assert.equal(result.error?.code, 'DEADLINE_EXCEEDED');
  assert.equal(actions.calls.length, 0);
});

test('false postcondition is partial and carries the failed condition', async () => {
  const actions = new FakeActions();
  actions.responses = [succeeded()];
  actions.queryOutcome = { status: 'succeeded', data: { value: false, observed: 0 } };
  const controller = new ActionController(actions);
  const result = await controller.execute(command({
    postconditions: [{ kind: 'inventory_at_least', item: 'stone', count: 1 }],
  }));

  assert.equal(result.status, 'partial');
  assert.equal(result.error?.code, 'POSTCONDITION_FAILED');
  assert.equal(actions.calls.length, 1);
});
