import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor } from '../src/executor.js';
import { ActionController } from '../src/controller.js';
import { TaskScheduler } from '../src/scheduler.js';
import { CompanionBrain } from '../src/brain.js';
import {
  InteractionService,
  RuleBasedIntentClassifier,
  type ChatTransport,
  type PlayerMessage,
} from '../src/interaction.js';
import type { Action } from '../src/schema.js';
import type { ActionPort, QueryOutcome } from '../src/task.js';

class CaptureTransport implements ChatTransport {
  sent: Array<{ player: string; text: string }> = [];

  onMessage(): () => void {
    return () => {};
  }

  send(player: string, text: string): void {
    this.sent.push({ player, text });
  }
}

function message(text: string, id: string): PlayerMessage {
  return { id, player: 'alice', text, receivedAt: Date.now(), channel: 'chat' };
}

test('player command flows through interaction, brain, scheduler, controller and executor', async () => {
  const snapshot = {
    position: { x: 10.2, y: 64, z: 20.8 },
    inventory: [{ name: 'oak_log', count: 5 }, { name: 'dirt', count: 3 }],
    entities: [{ id: 42, username: 'alice', name: 'alice', position: { x: 12.4, y: 64, z: 22.1 } }],
  };

  const query = (input: unknown): QueryOutcome => {
    const q = input as { type?: string };
    if (q.type === 'snapshot') return { status: 'succeeded', data: snapshot };
    return { status: 'failed', error: 'unsupported query in e2e test' };
  };

  const executed: Action[] = [];
  const executor = new ActionExecutor(async action => {
    executed.push(action);
    return { evidence: 'position_observed', position: { x: 12, y: 64, z: 22 } };
  });
  const port: ActionPort = {
    execute: (action, options) => executor.execute(action, options),
    query,
    stop: reason => executor.stop(reason),
    get busy() { return executor.busy; },
  };

  const controller = new ActionController(port);
  const scheduler = new TaskScheduler(controller);
  const brain = new CompanionBrain({ query });
  const transport = new CaptureTransport();
  const interaction = new InteractionService(
    transport,
    new RuleBasedIntentClassifier(),
    brain,
    scheduler,
    controller,
    undefined,
    {
      owners: ['alice'],
      autoRun: false,
      rateLimit: { windowMs: 10_000, max: 100 },
    },
  );

  await interaction.handle(message('过来', 'e2e-1'));

  const queued = scheduler.list();
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.state, 'queued');
  assert.equal(transport.sent.at(-1)?.text, '正在过去。');

  await scheduler.runUntilIdle();

  const finished = scheduler.get(queued[0]!.id);
  assert.equal(finished?.state, 'completed');
  assert.equal(executed.length, 1);
  assert.equal(executed[0]?.type, 'navigate');
  if (executed[0]?.type === 'navigate') {
    assert.deepEqual(executed[0].position, { x: 12, y: 64, z: 22 });
    assert.equal(executed[0].range, 2);
  }
});

test('inventory query uses read-only observation and never creates a task', async () => {
  const snapshot = {
    position: { x: 1, y: 64, z: 2 },
    inventory: [{ name: 'oak_log', count: 5 }, { name: 'dirt', count: 3 }],
    entities: [],
  };
  const query = (input: unknown): QueryOutcome => (input as { type?: string }).type === 'snapshot'
    ? { status: 'succeeded', data: snapshot }
    : { status: 'failed', error: 'unsupported' };
  const executed: Action[] = [];
  const executor = new ActionExecutor(async action => { executed.push(action); return {}; });
  const port: ActionPort = {
    execute: (action, options) => executor.execute(action, options),
    query,
    stop: reason => executor.stop(reason),
    get busy() { return executor.busy; },
  };
  const controller = new ActionController(port);
  const scheduler = new TaskScheduler(controller);
  const transport = new CaptureTransport();
  const interaction = new InteractionService(
    transport,
    new RuleBasedIntentClassifier(),
    new CompanionBrain({ query }),
    scheduler,
    controller,
    undefined,
    { owners: ['alice'], autoRun: false },
  );

  await interaction.handle(message('背包里有什么', 'e2e-2'));

  assert.equal(scheduler.list().length, 0);
  assert.equal(executed.length, 0);
  assert.match(transport.sent.at(-1)?.text ?? '', /oak_log x5/);
  assert.match(transport.sent.at(-1)?.text ?? '', /dirt x3/);
});

test('unsupported complex task returns clarify instead of inventing a plan', async () => {
  const query = (): QueryOutcome => ({ status: 'succeeded', data: { position: { x: 0, y: 64, z: 0 }, inventory: [], entities: [] } });
  const executor = new ActionExecutor(async () => ({}));
  const port: ActionPort = {
    execute: (action, options) => executor.execute(action, options),
    query,
    stop: reason => executor.stop(reason),
    get busy() { return executor.busy; },
  };
  const controller = new ActionController(port);
  const scheduler = new TaskScheduler(controller);
  const transport = new CaptureTransport();
  const interaction = new InteractionService(
    transport,
    new RuleBasedIntentClassifier(),
    new CompanionBrain({ query }),
    scheduler,
    controller,
    undefined,
    { owners: ['alice'], autoRun: false },
  );

  await interaction.handle(message('建个房子', 'e2e-3'));

  assert.equal(scheduler.list().length, 0);
  assert.match(transport.sent[0]?.text ?? '', /规划/);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(transport.sent.at(-1)?.text ?? '', /复杂任务规划还没实现/);
});
