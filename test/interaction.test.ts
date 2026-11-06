import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InteractionService,
  IntentRouter,
  isStopCommand,
  type ActionIntent,
  type ActionResolution,
  type ActionResolverPort,
  type BrainInput,
  type BrainOutput,
  type BrainPort,
  type ChatTransport,
  type Intent,
  type IntentClassifier,
  type IntentEnvelope,
  type PlayerMessage,
  type SchedulerPort,
} from '../src/interaction.js';
import type {
  ControllerCommand,
  ControllerPort,
  ControllerResult,
  Task,
  TaskSnapshot,
} from '../src/task.js';

class FakeTransport implements ChatTransport {
  sent: Array<{ player: string; text: string }> = [];
  handlers = new Set<(message: PlayerMessage) => void>();

  onMessage(handler: (message: PlayerMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(player: string, text: string): void {
    this.sent.push({ player, text });
  }

  emit(message: PlayerMessage): void {
    for (const handler of this.handlers) handler(message);
  }
}

class FakeClassifier implements IntentClassifier {
  calls = 0;
  envelope: IntentEnvelope = {
    intent: { kind: 'chat', text: 'hello' },
    confidence: 1,
    rawText: 'hello',
  };

  async classify(_input: { message: PlayerMessage }): Promise<IntentEnvelope> {
    this.calls++;
    return this.envelope;
  }
}

class FakeBrain implements BrainPort {
  calls: BrainInput[] = [];
  output: BrainOutput = { kind: 'reply', text: '好的' };

  async handle(input: BrainInput): Promise<BrainOutput> {
    this.calls.push(input);
    return this.output;
  }
}

class FakeScheduler implements SchedulerPort {
  submitted: Task[] = [];
  tasks = new Map<string, TaskSnapshot>();
  runCalls = 0;
  final: Partial<TaskSnapshot> = {};

  submit(task: Task): TaskSnapshot {
    this.submitted.push(task);
    const snapshot: TaskSnapshot = {
      id: task.id,
      state: 'queued',
      currentStep: 0,
      totalSteps: task.steps.length,
      attempts: 0,
      priority: task.priority ?? 0,
      dependsOn: [...(task.dependsOn ?? [])],
      submittedAt: Date.now(),
      ...this.final,
    };
    this.tasks.set(task.id, snapshot);
    return snapshot;
  }

  get(id: string): TaskSnapshot | undefined {
    return this.tasks.get(id);
  }

  list(): TaskSnapshot[] {
    return [...this.tasks.values()];
  }

  pause(): number { return 1; }
  resume(): number { return 1; }
  cancel(): boolean { return true; }
  stops: string[] = [];
  stop(reason?: string): void { this.stops.push(reason ?? ''); }

  async runUntilIdle(): Promise<TaskSnapshot[]> {
    this.runCalls++;
    return this.list();
  }
}

class FakeController implements ControllerPort {
  busy = false;
  stops: string[] = [];

  async execute(_command: ControllerCommand): Promise<ControllerResult> {
    throw new Error('controller should not execute from interaction tests');
  }

  stop(reason?: string): void {
    this.stops.push(reason ?? '');
  }
}

class FakeActionResolver implements ActionResolverPort {
  calls = 0;
  result: ActionResolution = {
    kind: 'actions',
    actions: [{ type: 'wait', durationMs: 1 }],
  };

  async resolve(): Promise<ActionResolution> {
    this.calls++;
    return this.result;
  }
}

function message(text: string, player = 'alice', id = String(Math.random())): PlayerMessage {
  return { id, player, text, receivedAt: Date.now(), channel: 'chat' };
}

function setup(options: {
  owners?: string[];
  classifier?: FakeClassifier;
  brain?: FakeBrain;
  scheduler?: FakeScheduler;
  controller?: FakeController;
  resolver?: FakeActionResolver;
  autoRun?: boolean;
} = {}) {
  const transport = new FakeTransport();
  const classifier = options.classifier ?? new FakeClassifier();
  const brain = options.brain ?? new FakeBrain();
  const scheduler = options.scheduler ?? new FakeScheduler();
  const controller = options.controller ?? new FakeController();
  const resolver = options.resolver;
  const service = new InteractionService(
    transport,
    classifier,
    brain,
    scheduler,
    controller,
    resolver,
    {
      owners: options.owners ?? ['alice'],
      rateLimit: { windowMs: 10_000, max: 100 },
      autoRun: options.autoRun ?? false,
    },
  );
  return { transport, classifier, brain, scheduler, controller, resolver, service };
}

test('stop is a fast path: no classifier, no brain, immediate controller.stop', async () => {
  const { transport, classifier, brain, scheduler, service } = setup();
  classifier.envelope = { intent: { kind: 'chat', text: 'wrong' }, confidence: 1, rawText: '停' };

  await service.handle(message('停'));

  assert.equal(classifier.calls, 0);
  assert.equal(brain.calls.length, 0);
  assert.deepEqual(scheduler.stops, ['玩家停止']);
  assert.equal(transport.sent.at(-1)?.text, '已停。');
});

test('guests cannot stop someone else\'s task', async () => {
  const { transport, classifier, controller, service } = setup({ owners: ['alice'] });

  await service.handle(message('停', 'bob', 'guest-stop'));

  assert.equal(classifier.calls, 0);
  assert.deepEqual(controller.stops, []);
  assert.match(transport.sent.at(-1)?.text ?? '', /只有 owner/);
});

test('task intent goes to brain and the resulting task is submitted with ownership', async () => {
  const { transport, classifier, brain, scheduler, service } = setup();
  classifier.envelope = { intent: { kind: 'task', goal: 'build a house' }, confidence: 1, rawText: '建房子' };
  brain.output = {
    kind: 'task',
    task: {
      id: 'build',
      steps: [{ id: 's1', actions: [{ type: 'wait', durationMs: 1 }] }],
    },
    ack: '开始建。',
  };

  await service.handle(message('建房子'));

  assert.equal(brain.calls.length, 1);
  assert.equal(scheduler.submitted.length, 1);
  assert.equal(scheduler.submitted[0]?.metadata?.owner, 'alice');
  assert.equal(transport.sent.at(-1)?.text, '开始建。');
});

test('gather summary uses the reported species instead of a hardcoded oak', async () => {
  const scheduler = new FakeScheduler();
  scheduler.final = {
    state: 'completed',
    lastResult: {
      taskId: 'gather',
      planRevision: 0,
      stepId: 's1',
      status: 'ok',
      data: { requested: 1, collected: 1, woodType: 'birch_log' },
      partialEffects: [],
      leaseState: 'free',
    },
  };
  const { transport, classifier, brain, service } = setup({ scheduler, autoRun: true });
  classifier.envelope = { intent: { kind: 'task', goal: '砍 1 个原木' }, confidence: 1, rawText: '砍 1 个原木' };
  brain.output = {
    kind: 'task',
    task: { id: 'gather', steps: [{ id: 's1', actions: [] }] },
    ack: '开始采集。',
  };

  await service.handle(message('砍 1 个原木', 'alice', 'gather-summary'));
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(transport.sent.some(entry => entry.text === '采集完成：获得 1 个 白桦原木。'));
  assert.equal(transport.sent.some(entry => entry.text.includes('橡木')), false);
});

test('confirmation is required before submitting a destructive task', async () => {
  const { transport, classifier, brain, scheduler, service } = setup();
  classifier.envelope = { intent: { kind: 'task', goal: 'toss items' }, confidence: 1, rawText: '丢掉' };
  brain.output = {
    kind: 'task',
    task: {
      id: 'toss',
      steps: [{ id: 's1', actions: [{ type: 'toss', item: 'stone', count: 1 }] }],
    },
    confirmation: '要丢掉 1 个石头吗？',
  };

  await service.handle(message('丢掉石头'));
  assert.equal(scheduler.submitted.length, 0);
  assert.equal(transport.sent.at(-1)?.text, '要丢掉 1 个石头吗？');

  classifier.envelope = { intent: { kind: 'confirm' }, confidence: 1, rawText: '是' };
  await service.handle(message('是', 'alice', 'confirm-1'));
  assert.equal(scheduler.submitted.length, 1);
  assert.equal(scheduler.submitted[0]?.id, 'toss');
});

test('clarification is stored and answered through the transport', async () => {
  const { transport, classifier, brain, service } = setup();
  classifier.envelope = { intent: { kind: 'task', goal: 'finish that' }, confidence: 0.8, rawText: '把那个做完' };
  brain.output = { kind: 'clarify', question: '你指哪个任务？' };

  await service.handle(message('把那个做完'));

  assert.equal(transport.sent.at(-1)?.text, '你指哪个任务？');
});

test('query status is answered from scheduler without calling brain', async () => {
  const { transport, classifier, brain, scheduler, service } = setup();
  classifier.envelope = { intent: { kind: 'task', goal: 'build' }, confidence: 1, rawText: '建' };
  brain.output = {
    kind: 'task',
    task: { id: 'status-task', steps: [{ id: 's1', actions: [{ type: 'wait', durationMs: 1 }] }] },
  };
  await service.handle(message('建'));

  const callsBefore = brain.calls.length;
  classifier.envelope = { intent: { kind: 'query', question: '进度', scope: 'status' }, confidence: 1, rawText: '进度' };
  await service.handle(message('进度', 'alice', 'status-1'));

  assert.equal(brain.calls.length, callsBefore);
  assert.match(transport.sent.at(-1)?.text ?? '', /status-task/);
});

test('guests can chat/query but cannot start tasks', async () => {
  const { transport, classifier, brain, scheduler, service } = setup({ owners: ['alice'] });
  classifier.envelope = { intent: { kind: 'task', goal: 'build' }, confidence: 1, rawText: '建' };

  await service.handle(message('建', 'bob', 'guest-task'));
  assert.equal(brain.calls.length, 0);
  assert.equal(scheduler.submitted.length, 0);
  assert.match(transport.sent.at(-1)?.text ?? '', /只有 owner/);

  classifier.envelope = { intent: { kind: 'query', question: 'help', scope: 'help' }, confidence: 1, rawText: '帮助' };
  await service.handle(message('帮助', 'bob', 'guest-help'));
  assert.match(transport.sent.at(-1)?.text ?? '', /可以让我/);
});

test('action intent uses the resolver and creates a single-step task', async () => {
  const { transport, classifier, scheduler, resolver, service } = setup({ resolver: new FakeActionResolver() });
  const actionIntent: ActionIntent = {
    kind: 'action',
    command: 'follow',
    target: { kind: 'player', name: 'alice' },
  };
  classifier.envelope = { intent: actionIntent, confidence: 1, rawText: '跟着我' };

  await service.handle(message('跟着我'));

  assert.equal(resolver?.calls, 1);
  assert.equal(scheduler.submitted.length, 1);
  assert.equal(scheduler.submitted[0]?.steps[0]?.actions[0]?.type, 'wait');
  assert.equal(transport.sent.at(-1)?.text, '收到，开始执行。');
});

test('only stop, pause, resume and cancel bypass the model', async () => {
  let calls = 0;
  const router = new IntentRouter({
    complete: async () => {
      calls++;
      return JSON.stringify({ kind: 'reply', text: 'model should not run' });
    },
  }, 500);
  const classify = async (text: string) => (await router.classify({ message: message(text) })).intent;
  assert.equal(isStopCommand('停'), true);
  assert.equal(isStopCommand('停止挖矿'), true);
  assert.equal(isStopCommand('继续'), false);
  assert.deepEqual(await classify('停'), { kind: 'control.stop' });
  assert.equal((await classify('暂停')).kind, 'control.pause');
  assert.equal((await classify('继续')).kind, 'control.resume');
  assert.equal((await classify('取消')).kind, 'control.cancel');
  assert.equal(calls, 0);
});

test('yes and no are classified by the model, not local keywords', async () => {
  let calls = 0;
  const router = new IntentRouter({
    complete: async () => {
      calls++;
      return JSON.stringify({ kind: 'reply', text: 'model reply' });
    },
  }, 500);
  const yes = await router.classify({ message: message('是') });
  const no = await router.classify({ message: message('不') });
  assert.equal(yes.intent.kind, 'direct.reply');
  assert.equal(no.intent.kind, 'direct.reply');
  assert.equal(calls, 2);
});

test('non-safety messages never fall back to keyword routing', async () => {
  const router = new IntentRouter({
    complete: async () => { throw new Error('model unavailable'); },
  }, 500);
  for (const text of ['进度', '建个房子', '你好', '你背包里有什么食物', '跟着我']) {
    const result = await router.classify({ message: message(text) });
    assert.equal(result.intent.kind, 'clarify', text);
  }
});

test('model-first router passes an inventory category filter through', async () => {
  const router = new IntentRouter({
    complete: async () => JSON.stringify({ kind: 'query', scope: 'inventory', filter: 'tools', question: '你背包里有什么工具' }),
  }, 500);
  const result = await router.classify({ message: message('你背包里有什么工具') });
  assert.equal(result.intent.kind, 'query');
  if (result.intent.kind === 'query') {
    assert.equal(result.intent.scope, 'inventory');
    assert.equal(result.intent.filter, 'tools');
  }
});

test('fast router accepts a validated inventory query without a rule alias', async () => {
  const fakeLlm = {
    complete: async () => JSON.stringify({ kind: 'skill', skill: 'report_inventory', params: {} }),
  };
  const router = new IntentRouter(fakeLlm, 500);
  const result = await router.classify({ message: message('please show me what you carry') });
  assert.equal(result.intent.kind, 'skill');
  if (result.intent.kind === 'skill') assert.equal(result.intent.skill, 'report_inventory');
});

test('model-first router recognizes skills without a rule alias', async () => {
  let calls = 0;
  const router = new IntentRouter({
    complete: async () => {
      calls++;
      return JSON.stringify({ kind: 'skill', skill: 'follow_player', params: {} });
    },
  }, 500);
  const result = await router.classify({ message: message('could you tag along?') });
  assert.equal(result.intent.kind, 'skill');
  if (result.intent.kind === 'skill') assert.equal(result.intent.skill, 'follow_player');
  assert.equal(calls, 1);
});

test('model-first router keeps safety controls out of the model', async () => {
  let calls = 0;
  const router = new IntentRouter({
    complete: async () => {
      calls++;
      return JSON.stringify({ kind: 'reply', text: 'should not be used' });
    },
  }, 500);
  const result = await router.classify({ message: message('停') });
  assert.deepEqual(result.intent, { kind: 'control.stop' });
  assert.equal(calls, 0);
});

test('model-first router grounds navigate coordinates in the player message', async () => {
  const router = new IntentRouter({
    complete: async () => JSON.stringify({ kind: 'skill', skill: 'navigate_to', params: { x: 1, y: 2, z: 3 } }),
  }, 500);
  const hallucinated = await router.classify({ message: message('go over there') });
  assert.equal(hallucinated.intent.kind, 'clarify');

  const groundedRouter = new IntentRouter({
    complete: async () => JSON.stringify({ kind: 'skill', skill: 'navigate_to', params: { x: 2, y: 64, z: 2 } }),
  }, 500);
  const grounded = await groundedRouter.classify({ message: message('走到坐标 2 64 2') });
  assert.equal(grounded.intent.kind, 'skill');
  if (grounded.intent.kind === 'skill') {
    assert.equal(grounded.intent.skill, 'navigate_to');
    assert.deepEqual(grounded.intent.params, { x: 2, y: 64, z: 2 });
  }
});

test('model-first router grounds store_items container coordinates', async () => {
  const store = { kind: 'skill', skill: 'store_items', params: { container: { x: 2, y: 64, z: 2 }, item: 'oak_log', count: 16 } };
  const router = new IntentRouter({ complete: async () => JSON.stringify(store) }, 500);
  const hallucinated = await router.classify({ message: message('把原木放进箱子') });
  assert.equal(hallucinated.intent.kind, 'clarify');

  const groundedRouter = new IntentRouter({ complete: async () => JSON.stringify(store) }, 500);
  const grounded = await groundedRouter.classify({ message: message('把 16 个原木放进坐标 2 64 2 的箱子') });
  assert.equal(grounded.intent.kind, 'skill');
  if (grounded.intent.kind === 'skill') {
    assert.equal(grounded.intent.skill, 'store_items');
    assert.deepEqual(grounded.intent.params, store.params);
  }
});

test('model-first router grounds craft_item table coordinates', async () => {
  const craft = { kind: 'skill', skill: 'craft_item', params: { item: 'oak_planks', count: 4, table: { x: 2, y: 64, z: 2 } } };
  const router = new IntentRouter({ complete: async () => JSON.stringify(craft) }, 500);
  const hallucinated = await router.classify({ message: message('帮我做 4 个木板') });
  assert.equal(hallucinated.intent.kind, 'clarify');

  const groundedRouter = new IntentRouter({ complete: async () => JSON.stringify(craft) }, 500);
  const grounded = await groundedRouter.classify({ message: message('用坐标 2 64 2 的工作台做 4 个木板') });
  assert.equal(grounded.intent.kind, 'skill');
  if (grounded.intent.kind === 'skill') {
    assert.equal(grounded.intent.skill, 'craft_item');
    assert.deepEqual(grounded.intent.params, craft.params);
  }
});

test('model-first router grounds deliver_to_player names and defaults to the speaker', async () => {
  const deliver = { kind: 'skill', skill: 'deliver_to_player', params: { item: 'oak_log', count: 3, player: 'bob' } };
  const router = new IntentRouter({ complete: async () => JSON.stringify(deliver) }, 500);
  const hallucinated = await router.classify({ message: message('给他 3 个原木') });
  assert.equal(hallucinated.intent.kind, 'clarify');

  const groundedRouter = new IntentRouter({ complete: async () => JSON.stringify(deliver) }, 500);
  const grounded = await groundedRouter.classify({ message: message('把 3 个原木交给 bob') });
  assert.equal(grounded.intent.kind, 'skill');
  if (grounded.intent.kind === 'skill') {
    assert.equal(grounded.intent.skill, 'deliver_to_player');
    assert.deepEqual(grounded.intent.params, deliver.params);
  }

  const toSpeaker = { kind: 'skill', skill: 'deliver_to_player', params: { item: 'oak_log', count: 3 } };
  const speakerRouter = new IntentRouter({ complete: async () => JSON.stringify(toSpeaker) }, 500);
  const speaker = await speakerRouter.classify({ message: message('给我 3 个原木') });
  assert.equal(speaker.intent.kind, 'skill');
});

test('model-first router accepts find_resource with block names', async () => {
  const router = new IntentRouter({
    complete: async () => JSON.stringify({ kind: 'skill', skill: 'find_resource', params: { names: ['oak_log'], radius: 16, limit: 8 } }),
  }, 500);
  const result = await router.classify({ message: message('附近哪里有成片的橡木') });
  assert.equal(result.intent.kind, 'skill');
  if (result.intent.kind === 'skill') {
    assert.equal(result.intent.skill, 'find_resource');
    assert.deepEqual(result.intent.params, { names: ['oak_log'], radius: 16, limit: 8 });
  }
});

test('model-first router passes the food inventory filter through', async () => {
  const router = new IntentRouter({
    complete: async () => JSON.stringify({ kind: 'skill', skill: 'report_inventory', params: { filter: 'food' } }),
  }, 500);
  const result = await router.classify({ message: message('你背包里有什么食物') });
  assert.equal(result.intent.kind, 'skill');
  if (result.intent.kind === 'skill') {
    assert.equal(result.intent.skill, 'report_inventory');
    assert.deepEqual(result.intent.params, { filter: 'food' });
  }
});
