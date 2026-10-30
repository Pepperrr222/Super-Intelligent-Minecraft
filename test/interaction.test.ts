import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InteractionService,
  RuleBasedIntentClassifier,
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
  stop(): void {}

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
      autoRun: false,
    },
  );
  return { transport, classifier, brain, scheduler, controller, resolver, service };
}

test('stop is a fast path: no classifier, no brain, immediate controller.stop', async () => {
  const { transport, classifier, brain, controller, service } = setup();
  classifier.envelope = { intent: { kind: 'chat', text: 'wrong' }, confidence: 1, rawText: '停' };

  await service.handle(message('停'));

  assert.equal(classifier.calls, 0);
  assert.equal(brain.calls.length, 0);
  assert.deepEqual(controller.stops, ['玩家停止']);
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

test('rule classifier covers stop, control, status and task fallback', async () => {
  const classifier = new RuleBasedIntentClassifier();
  const classify = async (text: string) => (await classifier.classify({ message: message(text) })).intent;
  assert.equal(isStopCommand('停'), true);
  assert.equal(isStopCommand('停止挖矿'), true);
  assert.equal(isStopCommand('继续'), false);
  assert.deepEqual(await classify('停'), { kind: 'control.stop' });
  assert.equal((await classify('暂停')).kind, 'control.pause');
  const status = await classify('进度');
  assert.equal(status.kind, 'query');
  if (status.kind === 'query') assert.equal(status.scope, 'status');
  assert.equal((await classify('建个房子')).kind, 'task');
  assert.equal((await classify('你好')).kind, 'chat');
});
