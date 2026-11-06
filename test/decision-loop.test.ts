import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ActionController } from '../src/controller.js';
import { TaskScheduler, MemoryTaskLedger } from '../src/scheduler.js';
import { CompanionBrain } from '../src/brain.js';
import {
  InteractionService,
  type BrainPort,
  type ChatTransport,
  type PlayerMessage,
} from '../src/interaction.js';
import { ScriptedClassifier } from './scripted-classifier.js';
import { SkillRegistry, SkillRunError, type SkillContext, type SkillRunResult } from '../src/skill-runtime.js';
import { REJECTION_TEXT } from '../src/brain-decision.js';
import type { ActionPort } from '../src/task.js';
import type { Task } from '../src/task.js';
import type { LlmClient, LlmRequest } from '../src/llm.js';
import type { DecisionOutcome, DecisionPort, DecisionRequest } from '../src/brain-contract.js';

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

function gatherTask(id: string, params: Record<string, unknown> = {}): Task {
  return {
    id,
    goal: 'gather_wood',
    priority: 10,
    steps: [{
      id: `${id}-step`,
      actions: [],
      skill: { id: 'gather_wood', params },
      idempotent: false,
    }],
    metadata: { source: 'skill' },
  };
}

type RunSkill = (context?: SkillContext) => Promise<SkillRunResult>;

/** Simulates a long-running native step that only settles when the lease aborts. */
async function waitForAbort(context?: SkillContext): Promise<never> {
  await new Promise<void>((_, reject) => {
    if (context?.signal.aborted) return reject(new Error('cancelled'));
    context?.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
  throw new Error('unreachable');
}

function makeSetup(
  decide: (request: DecisionRequest, turn: number) => Promise<DecisionOutcome>,
  run: RunSkill,
) {
  const transport = new CaptureTransport();
  const registry = new SkillRegistry();
  registry.register({
    id: 'gather_wood',
    description: 'test gather',
    inputSchema: z.object({
      woodType: z.string().optional(),
      count: z.number().optional(),
    }).passthrough(),
    supportedVersions: ['1.21.1'],
    risk: 'requires_confirmation',
    requiredCapabilities: ['observe'],
    idempotent: false,
    run: async (_input, context) => run(context),
  });

  let actionId = 0;
  const port: ActionPort = {
    execute: async action => {
      actionId++;
      const type = (action as { type?: string }).type ?? 'unknown';
      return {
        id: `action-${actionId}`,
        type,
        status: 'succeeded',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        data: { evidence: 'client_observed' },
      };
    },
    query: () => ({ status: 'succeeded', data: { value: true } }),
    stop: () => {},
    get busy() { return false; },
  };

  const controller = new ActionController(port, registry);
  const scheduler = new TaskScheduler(controller, new MemoryTaskLedger(), registry);
  const brain: BrainPort = {
    handle: async () => { throw new Error('legacy brain must not run in decision mode'); },
  };
  const calls: DecisionRequest[] = [];
  const decision: DecisionPort = {
    decide: async request => {
      calls.push(request);
      return decide(request, calls.length - 1);
    },
  };
  const interaction = new InteractionService(
    transport,
    new ScriptedClassifier({}),
    brain,
    scheduler,
    controller,
    undefined,
    {
      owners: ['alice'],
      autoRun: true,
      rateLimit: { windowMs: 10_000, max: 100 },
      pendingTtlMs: 60_000,
    },
    decision,
  );
  return { transport, scheduler, interaction, calls };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const success: RunSkill = async () => ({
  status: 'succeeded',
  output: { requested: 2, collected: 2, woodType: 'oak_log' },
});

test('decision loop executes a task, reports verified feedback and allows one follow-up reply', async () => {
  const setup = makeSetup(async (request, turn) => {
    if (turn === 0) return { kind: 'task', task: gatherTask('task-a'), ack: '开始。' };
    return { kind: 'reply', text: '还需要什么吗？' };
  }, success);

  await setup.interaction.handle(message('砍 2 个原木', 'm1'));
  await waitFor(() => setup.calls.length >= 2 && setup.transport.sent.some(entry => entry.text === '还需要什么吗？'), 'follow-up reply');

  assert.equal(setup.calls[0]?.trigger, 'player_message');
  assert.equal(setup.calls[1]?.trigger, 'run_finished');
  assert.equal(setup.calls[1]?.lastRun?.outcome, 'completed');
  assert.equal(setup.calls[1]?.lastRun?.verified, true);
  assert.ok(setup.transport.sent.some(entry => entry.text === '完成：获得 2 个 橡木原木。'));
  assert.equal(setup.scheduler.get('task-a')?.state, 'completed');
});

test('a completed goal cannot silently start another task', async () => {
  const setup = makeSetup(async (_request, turn) => turn === 0
    ? { kind: 'task', task: gatherTask('task-a'), ack: '开始。' }
    : { kind: 'task', task: gatherTask('task-b'), ack: '继续。' }, success);

  await setup.interaction.handle(message('砍 2 个原木', 'm1'));
  await waitFor(() => setup.transport.sent.some(entry => entry.text.includes('这个目标已经完成')), 'completion denial');

  assert.equal(setup.calls.length, 2);
  assert.equal(setup.scheduler.list().length, 1);
  assert.equal(setup.scheduler.get('task-a')?.state, 'completed');
});

test('cancelled tasks never trigger an automatic follow-up', async () => {
  const setup = makeSetup(async (_request, turn) => turn === 0
    ? { kind: 'task', task: gatherTask('task-a'), ack: '开始。' }
    : { kind: 'reply', text: '不应该出现' }, async () => ({
    status: 'cancelled',
    error: { code: 'CANCELLED', message: '被停止' },
  }));

  await setup.interaction.handle(message('砍树', 'm1'));
  await waitFor(() => setup.transport.sent.some(entry => entry.text.startsWith('已取消')), 'cancellation feedback');

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.scheduler.get('task-a')?.state, 'cancelled');
  assert.equal(setup.transport.sent.some(entry => entry.text === '不应该出现'), false);
});

test('a blocked task does not block the next player goal', async () => {
  let runs = 0;
  const run: RunSkill = async () => {
    runs++;
    return runs === 1
      ? { status: 'blocked', error: { code: 'NO_DROPS_OBSERVED', message: '附近没有可拾取的掉落物' } }
      : { status: 'succeeded', output: { requested: 1, collected: 1, woodType: 'birch_log' } };
  };
  const setup = makeSetup(async (_request, turn) => {
    if (turn === 0) return { kind: 'task', task: gatherTask('task-blocked', { count: 1 }), ack: '开始拾取。' };
    if (turn === 1) return { kind: 'reply', text: '拾取没成功。' };
    return { kind: 'task', task: gatherTask('task-next', { count: 1 }), ack: '开始砍树。' };
  }, run);

  await setup.interaction.handle(message('把地上的原木捡起来', 'm1'));
  await waitFor(() => setup.calls.length >= 2 && setup.transport.sent.some(entry => entry.text === '拾取没成功。'), 'blocked follow-up');
  assert.equal(setup.scheduler.get('task-blocked')?.state, 'blocked');

  await setup.interaction.handle(message('砍树', 'm2'));
  await waitFor(() => setup.transport.sent.some(entry => entry.text === '开始砍树。'), 'new goal after blocked');

  assert.equal(setup.calls[2]?.currentTask, undefined);
  assert.equal(setup.scheduler.list().length, 2);
  assert.equal(setup.transport.sent.some(entry => entry.text.includes('当前还有任务在运行')), false);
  await waitFor(() => setup.scheduler.get('task-next')?.state === 'completed', 'next task completion');
});

test('the model can end a running task when the player asks to stop it', async () => {
  let runs = 0;
  const setup = makeSetup(async (request, turn) => {
    if (turn === 0) return { kind: 'task', task: gatherTask('task-a'), ack: '开始。' };
    if (request.message?.text === '结束') {
      assert.ok(request.currentTask);
      return { kind: 'control', action: 'cancel', taskId: request.currentTask.id };
    }
    return { kind: 'reply', text: '已结束，等你下一步。' };
  }, async context => {
    runs++;
    if (runs === 1) await waitForAbort(context);
    return { status: 'succeeded', output: { requested: 2, collected: 2, woodType: 'oak_log' } };
  });

  await setup.interaction.handle(message('砍 2 个原木', 'm1'));
  await waitFor(() => runs === 1 && setup.scheduler.get('task-a')?.state === 'running', 'task running');

  await setup.interaction.handle(message('结束', 'm2'));
  await waitFor(() => setup.scheduler.get('task-a')?.state === 'cancelled', 'model-issued cancellation');

  assert.equal(setup.calls[1]?.currentTask?.id, 'task-a');
  assert.ok(setup.transport.sent.some(entry => entry.text === '已结束当前任务。'));
  assert.ok(setup.transport.sent.some(entry => entry.text.startsWith('已取消')));
  assert.equal(setup.scheduler.list().length, 1);
});

test('the model can replace a running task when the player changes goal', async () => {
  let runs = 0;
  const setup = makeSetup(async (request, turn) => {
    if (turn === 0) return { kind: 'task', task: gatherTask('task-a', { count: 2 }), ack: '开始挖。' };
    if (request.message?.text === '砍树') {
      assert.ok(request.currentTask);
      return {
        kind: 'task',
        task: gatherTask('task-b', { count: 1 }),
        ack: '开始砍树。',
        replaceCurrent: true,
      };
    }
    return { kind: 'reply', text: '换好了。' };
  }, async context => {
    runs++;
    if (runs === 1) await waitForAbort(context);
    return { status: 'succeeded', output: { requested: 1, collected: 1, woodType: 'birch_log' } };
  });

  await setup.interaction.handle(message('挖两个原木', 'm1'));
  await waitFor(() => runs === 1 && setup.scheduler.get('task-a')?.state === 'running', 'task running');

  await setup.interaction.handle(message('砍树', 'm2'));
  await waitFor(() => setup.scheduler.get('task-b')?.state === 'completed'
    && setup.transport.sent.some(entry => entry.text === '完成：获得 1 个 白桦原木。'), 'replacement completion');

  assert.equal(setup.scheduler.get('task-a')?.state, 'cancelled');
  assert.ok(setup.transport.sent.some(entry => entry.text === '已停止当前任务；开始砍树。'));
  assert.equal(setup.transport.sent.some(entry => entry.text.includes('当前还有任务在运行')), false);
  assert.ok(setup.transport.sent.some(entry => entry.text === '完成：获得 1 个 白桦原木。'));
  assert.equal(setup.calls[1]?.currentTask?.id, 'task-a');
});

test('a failed run may replan once with a different call', async () => {
  let runs = 0;
  const setup = makeSetup(async (_request, turn) => {
    if (turn === 0) return { kind: 'task', task: gatherTask('task-a', { woodType: 'oak_log', count: 1 }), ack: '开始。' };
    if (turn === 1) return { kind: 'task', task: gatherTask('task-b', { woodType: 'birch_log', count: 1 }), ack: '换白桦试试。' };
    return { kind: 'reply', text: '完成了。' };
  }, async () => {
    runs++;
    if (runs === 1) throw new SkillRunError('NO_TREE', '附近没有带树叶的橡木');
    return { status: 'succeeded', output: { requested: 1, collected: 1, woodType: 'birch_log' } };
  });

  await setup.interaction.handle(message('砍 1 个橡木', 'm1'));
  await waitFor(() => setup.calls.length >= 3 && setup.transport.sent.some(entry => entry.text === '完成了。'), 'replan completion');

  assert.equal(setup.calls[1]?.lastRun?.outcome, 'failed');
  assert.equal(setup.calls[1]?.lastRun?.retryable, true);
  assert.equal(setup.calls[2]?.lastRun?.outcome, 'completed');
  assert.equal(setup.calls[2]?.lastRun?.verified, true);
  assert.ok(setup.transport.sent.some(entry => entry.text === '失败：附近没有带树叶的橡木。'));
  assert.ok(setup.transport.sent.some(entry => entry.text === '完成：获得 1 个 白桦原木。'));
  assert.equal(setup.scheduler.get('task-a')?.state, 'failed');
  assert.equal(setup.scheduler.get('task-b')?.state, 'completed');
});

test('the same call failing twice is reported back to the model as blocked', async () => {
  const params = { woodType: 'oak_log', count: 1 };
  const key = 'gather_wood:{"count":1,"woodType":"oak_log"}';
  const setup = makeSetup(async (_request, turn) => {
    if (turn === 0) return { kind: 'task', task: gatherTask('task-a', params), ack: '开始。' };
    if (turn === 1) return { kind: 'task', task: gatherTask('task-b', params), ack: '重试。' };
    return { kind: 'clarify', question: '换一种方法？' };
  }, async () => {
    throw new SkillRunError('NO_TREE', '附近没有树');
  });

  await setup.interaction.handle(message('砍橡木', 'm1'));
  await waitFor(() => setup.calls.length >= 3 && setup.transport.sent.some(entry => entry.text === '换一种方法？'), 'blocked clarification');

  assert.deepEqual(setup.calls[2]?.blockedCalls, [key]);
  assert.equal(setup.calls[2]?.lastRun?.repeatedFailure, true);
  assert.equal(setup.scheduler.get('task-a')?.state, 'failed');
  assert.equal(setup.scheduler.get('task-b')?.state, 'failed');
});

test('stop aborts an in-flight decision and discards its late result', async () => {
  let signal: AbortSignal | undefined;
  const setup = makeSetup(request => new Promise<DecisionOutcome>((_, reject) => {
    signal = request.signal;
    request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), success);

  const pending = setup.interaction.handle(message('砍树', 'm1'));
  await waitFor(() => Boolean(signal), 'decision start');
  assert.equal(signal?.aborted, false);

  await setup.interaction.handle(message('停', 'm2'));
  await pending;

  assert.equal(signal?.aborted, true);
  assert.ok(setup.transport.sent.some(entry => entry.text === '已停。'));
  assert.equal(setup.scheduler.list().length, 0);
});

test('a newer player turn suppresses the automatic follow-up of an older task', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const setup = makeSetup(async (_request, turn) => {
    if (turn === 0) return { kind: 'task', task: gatherTask('task-a'), ack: '开始。' };
    return { kind: 'reply', text: `决策 ${turn}` };
  }, async () => {
    await gate;
    return { status: 'succeeded', output: { requested: 2, collected: 2, woodType: 'oak_log' } };
  });

  await setup.interaction.handle(message('砍 2 个原木', 'm1'));
  await setup.interaction.handle(message('顺便聊一句', 'm2'));
  assert.equal(setup.transport.sent.some(entry => entry.text === '决策 1'), true);

  release();
  await waitFor(() => setup.transport.sent.some(entry => entry.text === '完成：获得 2 个 橡木原木。'), 'task feedback');

  assert.equal(setup.calls.length, 2);
  assert.equal(setup.transport.sent.some(entry => entry.text === '决策 2'), false);
});

test('a new player turn clears stale pending state after a successful decision', async () => {
  const setup = makeSetup(async (_request, turn) => {
    if (turn === 0) return { kind: 'task', task: gatherTask('task-a'), confirmation: '确认砍树？' };
    if (turn === 1) return { kind: 'reply', text: '好的。' };
    return { kind: 'reply', text: '嗯。' };
  }, success);

  await setup.interaction.handle(message('砍树', 'm1'));
  await setup.interaction.handle(message('先算了', 'm2'));
  await setup.interaction.handle(message('你好', 'm3'));

  assert.equal(setup.calls[1]?.session.pending?.kind, 'confirm');
  assert.equal(setup.calls[2]?.session.pending, undefined);
  assert.equal(setup.scheduler.list().length, 0);
});

test('another running task blocks a new confirmation and leaves no stale pending state', async () => {
  const setup = makeSetup(async (_request, turn) => turn === 0
    ? { kind: 'task', task: gatherTask('task-a', { count: 1 }), confirmation: '确认砍树？' }
    : { kind: 'reply', text: '嗯。' }, success);

  // Another player already owns the single action controller.
  setup.scheduler.submit(gatherTask('busy'));

  await setup.interaction.handle(message('砍 1 个原木', 'm1'));

  assert.ok(setup.transport.sent.some(entry => entry.text.includes('当前还有任务在运行')));
  assert.equal(setup.transport.sent.some(entry => entry.text === '确认砍树？'), false);

  await setup.interaction.handle(message('你好', 'm2'));
  assert.equal(setup.calls[1]?.session.pending, undefined);
  assert.equal(setup.scheduler.list().length, 1);
});

test('cancel clears a pending confirmation and allows a new goal', async () => {
  let runs = 0;
  const setup = makeSetup(async (_request, turn) => {
    if (turn === 0) return { kind: 'task', task: gatherTask('task-a', { count: 1 }), ack: '开始。' };
    if (turn === 1) return { kind: 'task', task: gatherTask('task-b', { count: 1 }), confirmation: '再试一次？' };
    return { kind: 'task', task: gatherTask('task-c', { count: 1 }), ack: '新任务。' };
  }, async () => {
    runs++;
    if (runs === 1) throw new SkillRunError('NO_TREE', '附近没有树');
    return { status: 'succeeded', output: { requested: 1, collected: 1, woodType: 'oak_log' } };
  });

  await setup.interaction.handle(message('砍 1 个原木', 'm1'));
  await waitFor(() => setup.transport.sent.some(entry => entry.text === '再试一次？'), 'pending confirmation');

  await setup.interaction.handle(message('取消', 'm2'));
  await setup.interaction.handle(message('重新砍一个', 'm3'));
  await waitFor(() => setup.scheduler.get('task-c')?.state === 'completed', 'task after cancel');

  assert.equal(setup.calls[1]?.trigger, 'run_finished');
  assert.equal(setup.calls[2]?.message?.text, '重新砍一个');
  assert.equal(setup.calls[2]?.session.pending, undefined);
  assert.equal(setup.scheduler.list().length, 2);
});

class FakeLlm implements LlmClient {
  requests: LlmRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) throw new Error('no fake response');
    return next;
  }
}

const rawObservation = {
  version: '1.21.1',
  dimension: 'minecraft:overworld',
  gameMode: 'survival',
  perceptionRadius: 16,
  position: { x: 0, y: 64, z: 0 },
  health: 20,
  food: 20,
  inventory: [{ name: 'oak_log', count: 5, slot: 36, fingerprint: 'fp-secret', nbt: { hidden: true } }],
  entities: [{ id: 1, uuid: 'entity-uuid-secret', username: 'alice', name: 'alice', position: { x: 2, y: 64, z: 2 }, metadata: {} }],
};

function decisionRequest(text: string): DecisionRequest {
  return {
    trigger: 'player_message',
    player: { name: 'alice', isOwner: true },
    session: { player: 'alice', recent: [] },
    message: { id: 'm', player: 'alice', text, receivedAt: Date.now(), channel: 'chat' },
  };
}

test('CompanionBrain.decide sends a redacted context and validates the reply', async () => {
  const llm = new FakeLlm(['{"kind":"skill","skill":"report_inventory","params":{}}']);
  const brain = new CompanionBrain(
    { query: () => ({ status: 'succeeded', data: rawObservation }) },
    { llm },
  );

  const outcome = await brain.decide(decisionRequest('背包里有什么'));

  assert.equal(outcome.kind, 'reply');
  if (outcome.kind === 'reply') assert.match(outcome.text, /oak_log x5/);
  assert.equal(llm.requests.length, 1);
  const sent = llm.requests[0]!.user;
  const payload = JSON.parse(sent) as { schema: string; availableSkills: unknown[]; observation: unknown };
  assert.equal(payload.schema, 'sim.brain.v1');
  assert.equal(payload.availableSkills.length, 10);
  assert.match(sent, /"text":"背包里有什么"/);
  for (const forbidden of ['fp-secret', 'entity-uuid-secret', 'fingerprint', 'uuid', '"slot":36', 'nbt']) {
    assert.equal(sent.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.match(llm.requests[0]!.system, /只使用 availableSkills/);
});

test('CompanionBrain.decide rejects malformed or ungrounded model output', async () => {
  const malformed = new FakeLlm(['not json']);
  const brain = new CompanionBrain(
    { query: () => ({ status: 'succeeded', data: rawObservation }) },
    { llm: malformed },
  );
  const invalid = await brain.decide(decisionRequest('你好'));
  assert.deepEqual(invalid, { kind: 'reply', text: REJECTION_TEXT.DECISION_JSON_INVALID });

  const ungrounded = new FakeLlm(['{"kind":"skill","skill":"navigate_to","params":{"x":1,"y":2,"z":3}}']);
  const navigating = new CompanionBrain(
    { query: () => ({ status: 'succeeded', data: rawObservation }) },
    { llm: ungrounded },
  );
  const hallucinated = await navigating.decide(decisionRequest('去那边'));
  assert.deepEqual(hallucinated, { kind: 'reply', text: REJECTION_TEXT.UNGROUNDED_COORDINATES });
});

test('CompanionBrain.decide fails closed without a model', async () => {
  const brain = new CompanionBrain({ query: () => ({ status: 'succeeded', data: rawObservation }) });
  const outcome = await brain.decide(decisionRequest('砍树'));
  assert.equal(outcome.kind, 'clarify');
  if (outcome.kind === 'clarify') assert.match(outcome.question, /决策模型未配置/);
});

test('CompanionBrain.decide propagates cancellation instead of replying', async () => {
  const llm: LlmClient = {
    complete: request => new Promise<string>((_, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  };
  const brain = new CompanionBrain(
    { query: () => ({ status: 'succeeded', data: rawObservation }) },
    { llm },
  );
  const controller = new AbortController();
  const pending = brain.decide({ ...decisionRequest('砍树'), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
});
