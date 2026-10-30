import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskScheduler } from '../src/scheduler.js';
import type {
  ControllerCommand,
  ControllerPort,
  ControllerResult,
  ControllerStatus,
  Task,
  TaskLedger,
  TaskRecord,
} from '../src/task.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function ok(command: ControllerCommand): ControllerResult {
  return {
    taskId: command.taskId,
    planRevision: command.planRevision,
    stepId: command.step.id,
    status: 'ok',
    evidence: 'step_verified',
    partialEffects: [],
    leaseState: 'free',
  };
}

function result(command: ControllerCommand, status: ControllerStatus, code: string = status): ControllerResult {
  return {
    taskId: command.taskId,
    planRevision: command.planRevision,
    stepId: command.step.id,
    status,
    partialEffects: [],
    error: { code, message: status },
    leaseState: 'free',
  };
}

class FakeController implements ControllerPort {
  busy = false;
  commands: ControllerCommand[] = [];
  results: ControllerResult[] = [];
  stops: string[] = [];

  async execute(command: ControllerCommand): Promise<ControllerResult> {
    this.commands.push(command);
    return this.results.shift() ?? ok(command);
  }

  stop(reason?: string): void {
    this.stops.push(reason ?? '');
  }
}

class PendingController extends FakeController {
  resolveNext!: (result: ControllerResult) => void;

  override execute(command: ControllerCommand): Promise<ControllerResult> {
    this.commands.push(command);
    return new Promise(resolve => { this.resolveNext = resolve; });
  }
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    priority: 0,
    steps: [{
      id: `${id}-1`,
      actions: [{ type: 'wait', durationMs: 1 }],
    }],
    ...overrides,
  };
}

test('dispatches higher priority first and completes tasks', async () => {
  const controller = new FakeController();
  const scheduler = new TaskScheduler(controller);
  scheduler.submit(makeTask('low', { priority: 1 }));
  scheduler.submit(makeTask('high', { priority: 10 }));

  const snapshots = await scheduler.runUntilIdle();
  assert.deepEqual(controller.commands.map(command => command.taskId), ['high', 'low']);
  assert.equal(scheduler.get('high')?.state, 'completed');
  assert.equal(scheduler.get('low')?.state, 'completed');
  assert.equal(snapshots.length, 2);
});

test('waits for dependencies before dispatching', async () => {
  const controller = new FakeController();
  const scheduler = new TaskScheduler(controller);
  scheduler.submit(makeTask('base'));
  scheduler.submit(makeTask('dependent', { dependsOn: ['base'] }));

  await scheduler.runUntilIdle();
  assert.deepEqual(controller.commands.map(command => command.taskId), ['base', 'dependent']);
  assert.equal(scheduler.get('dependent')?.state, 'completed');
});

test('submitAll accepts a task graph in any order', async () => {
  const controller = new FakeController();
  const scheduler = new TaskScheduler(controller);
  scheduler.submitAll([
    makeTask('dependent', { dependsOn: ['base'] }),
    makeTask('base'),
  ]);

  await scheduler.runUntilIdle();
  assert.deepEqual(controller.commands.map(command => command.taskId), ['base', 'dependent']);
  assert.equal(scheduler.get('dependent')?.state, 'completed');
});

test('rejects retry on a non-idempotent step', () => {
  const scheduler = new TaskScheduler(new FakeController());
  assert.throws(() => scheduler.submit(makeTask('unsafe', {
    steps: [{
      id: 'unsafe-1',
      actions: [{ type: 'wait', durationMs: 1 }],
      retry: { maxAttempts: 2 },
    }],
  })), /RETRY_REQUIRES_IDEMPOTENT/);
});

test('retries an idempotent step up to maxAttempts', async () => {
  const controller = new FakeController();
  controller.results = [
    result({ taskId: 'retry', planRevision: 1, step: { id: 'retry-1', actions: [] } }, 'error', 'TEMPORARY'),
    ok({ taskId: 'retry', planRevision: 1, step: { id: 'retry-1', actions: [] } }),
  ];
  const scheduler = new TaskScheduler(controller);
  scheduler.submit(makeTask('retry', {
    steps: [{
      id: 'retry-1',
      actions: [{ type: 'wait', durationMs: 1 }],
      idempotent: true,
      retry: { maxAttempts: 2 },
    }],
  }));

  await scheduler.runUntilIdle();
  assert.equal(controller.commands.length, 2);
  assert.equal(scheduler.get('retry')?.state, 'completed');
});

test('does not retry a partial result even for an idempotent step', async () => {
  const controller = new FakeController();
  controller.results = [
    result({ taskId: 'partial', planRevision: 1, step: { id: 'partial-1', actions: [] } }, 'partial', 'PARTIAL'),
  ];
  const scheduler = new TaskScheduler(controller);
  scheduler.submit(makeTask('partial', {
    steps: [{
      id: 'partial-1',
      actions: [{ type: 'wait', durationMs: 1 }],
      idempotent: true,
      retry: { maxAttempts: 3 },
    }],
  }));

  await scheduler.runUntilIdle();
  assert.equal(controller.commands.length, 1);
  assert.equal(scheduler.get('partial')?.state, 'failed');
});

test('busy leaves the task queued and does not spin', async () => {
  const controller = new FakeController();
  controller.results = [
    result({ taskId: 'busy', planRevision: 1, step: { id: 'busy-1', actions: [] } }, 'busy', 'BUSY'),
  ];
  const scheduler = new TaskScheduler(controller);
  scheduler.submit(makeTask('busy'));

  const first = await scheduler.runUntilIdle();
  assert.equal(first[0]?.state, 'queued');
  assert.equal(first[0]?.lastResult?.status, 'busy');
  assert.equal(controller.commands.length, 1);

  await scheduler.runUntilIdle();
  assert.equal(scheduler.get('busy')?.state, 'completed');
});

test('cancels a queued task without dispatching it', async () => {
  const controller = new FakeController();
  const scheduler = new TaskScheduler(controller);
  scheduler.submit(makeTask('queued'));
  assert.equal(scheduler.cancel('queued'), true);
  await scheduler.runUntilIdle();

  assert.equal(controller.commands.length, 0);
  assert.equal(scheduler.get('queued')?.state, 'cancelled');
});

test('cancels a running task and stops the controller', async () => {
  const controller = new PendingController();
  const scheduler = new TaskScheduler(controller);
  scheduler.submit(makeTask('running'));

  const pending = scheduler.runNext();
  await tick();
  assert.equal(scheduler.get('running')?.state, 'running');
  assert.equal(scheduler.cancel('running', 'test stop'), true);
  assert.deepEqual(controller.stops, ['test stop']);

  controller.resolveNext(result(
    { taskId: 'running', planRevision: 1, step: { id: 'running-1', actions: [] } },
    'cancelled',
    'CANCELLED',
  ));
  await pending;
  assert.equal(scheduler.get('running')?.state, 'cancelled');
});

test('blocks a dependent task when its dependency fails', async () => {
  const controller = new FakeController();
  controller.results = [
    result({ taskId: 'base', planRevision: 1, step: { id: 'base-1', actions: [] } }, 'error', 'FAILED'),
  ];
  const scheduler = new TaskScheduler(controller);
  scheduler.submit(makeTask('base'));
  scheduler.submit(makeTask('dependent', { dependsOn: ['base'] }));

  await scheduler.runUntilIdle();
  assert.equal(scheduler.get('base')?.state, 'failed');
  assert.equal(scheduler.get('dependent')?.state, 'blocked');
  assert.equal(scheduler.get('dependent')?.lastResult?.error?.code, 'DEPENDENCY_FAILED');
  assert.equal(controller.commands.length, 1);
});

test('fails before dispatch when the task deadline has passed', async () => {
  const controller = new FakeController();
  const scheduler = new TaskScheduler(controller);
  scheduler.submit(makeTask('deadline', { deadline: Date.now() - 1 }));

  await scheduler.runUntilIdle();
  assert.equal(controller.commands.length, 0);
  assert.equal(scheduler.get('deadline')?.state, 'failed');
  assert.equal(scheduler.get('deadline')?.lastResult?.error?.code, 'DEADLINE_EXCEEDED');
});

test('pause prevents dispatch and resume allows it', async () => {
  const controller = new FakeController();
  const scheduler = new TaskScheduler(controller);
  scheduler.submit(makeTask('paused'));
  assert.equal(scheduler.pause('paused'), 1);
  assert.equal(await scheduler.runNext(), undefined);
  assert.equal(scheduler.get('paused')?.state, 'paused');

  assert.equal(scheduler.resume('paused'), 1);
  await scheduler.runUntilIdle();
  assert.equal(scheduler.get('paused')?.state, 'completed');
});

test('recovers a stale running record as blocked until explicitly resumed', async () => {
  const record: TaskRecord = {
    task: makeTask('recover'),
    planRevision: 1,
    state: 'running',
    currentStep: 0,
    attempts: 0,
    submittedAt: 1,
  };
  const ledger: TaskLedger = {
    load: () => [record],
    save: () => {},
    remove: () => {},
  };
  const scheduler = new TaskScheduler(new FakeController(), ledger);

  assert.equal(scheduler.get('recover')?.state, 'blocked');
  assert.equal(scheduler.get('recover')?.lastResult?.error?.code, 'RECOVERY_REQUIRED');
  assert.equal(await scheduler.runNext(), undefined);

  scheduler.resume('recover');
  await scheduler.runUntilIdle();
  assert.equal(scheduler.get('recover')?.state, 'completed');
});
