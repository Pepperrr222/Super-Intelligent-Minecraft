import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentBrain, brainPromptManifest } from '../src/agent-brain.js';
import { AgentLoop } from '../src/agent-loop.js';
import { CompanionRuntime } from '../src/runtime.js';
import type { LlmRequest } from '../src/llm.js';
import { fixture } from './fixtures.js';

test('brain rejects unreviewed or obsolete prompts before calling its client', async () => {
  let calls = 0;
  for (const approvedPromptHash of [undefined, 'previous-version']) {
    const brain = new AgentBrain({ director: { complete: async () => { calls++; return '{}'; } },
      requirePromptApproval: true, approvedPromptHash });
    await assert.rejects(brain.infer('decision', {}, new AbortController().signal), /BRAIN_PROMPTS_NOT_REVIEWED/);
  }
  assert.equal(calls, 0);
});

test('review manifest contains exactly the system messages sent for every brain role', async () => {
  const manifest = brainPromptManifest();
  const seen: LlmRequest[] = [];
  const brain = new AgentBrain({ requirePromptApproval: true, approvedPromptHash: manifest.hash,
    director: { complete: async request => { seen.push(request); return '{}'; } } });
  for (const prompt of manifest.prompts) {
    const response = await brain.infer(prompt.role, { message: { text: '你好' } }, new AbortController().signal);
    assert.equal(seen.at(-1)!.system, prompt.system);
    assert.equal(seen.at(-1)!.maxTokens, prompt.maxTokens);
    assert.equal(response.result.ok, false);
  }
  assert.equal(seen.length, 1); // Invalid output is returned to the budgeted orchestrator, never retried here.
  assert.deepEqual(manifest.prompts.map(p => p.role), ['decision']);
});

test('brain reports schema errors and accepts a corrected decision with original context intact', async () => {
  const seen: LlmRequest[] = [];
  const brain = new AgentBrain({ director: { complete: async request => {
    seen.push(request);
    return seen.length === 1 ? '{"kind":"skill","skill":"invented"}' : '{"kind":"respond","text":"你好。"}';
  } } });
  const payload = { message: { text: '你好' }, goal: { originalRequest: '保留已有任务' } };
  const first = await brain.infer('decision', payload, new AbortController().signal);
  assert.equal(first.result.ok, false);
  if (first.result.ok) assert.fail('invalid route must be rejected');
  const second = await brain.infer('decision', payload, new AbortController().signal, first.result.correction);
  assert.deepEqual(second.result, { ok: true, value: { kind: 'respond', text: '你好。' } });
  const retry = JSON.parse(seen[1].user);
  assert.deepEqual(retry.input, payload);
  assert.equal(retry.correction, first.result.correction);
});

test('brain uses one reasoning client and ignores a legacy executor client', async () => {
  const calls: string[] = [];
  const brain = new AgentBrain({ director: { complete: async () => { calls.push('director'); return '{}'; } },
    executor: { complete: async () => { calls.push('executor'); return '{}'; } } });
  await brain.infer('decision', {}, new AbortController().signal);
  await brain.infer('decision', {}, new AbortController().signal);
  await brain.infer('decision', {}, new AbortController().signal);
  assert.deepEqual(calls, ['director', 'director', 'director']);
});

test('brain cancellation discards a late response even if the provider ignores abort', async () => {
  let finish!: (text: string) => void;
  const brain = new AgentBrain({ director: { complete: () => new Promise(resolve => { finish = resolve; }) } });
  const abort = new AbortController();
  const work = brain.infer('decision', {}, abort.signal);
  abort.abort();
  await assert.rejects(work, /LLM_CANCELLED/);
  finish('{"kind":"respond","text":"迟到回复"}');
});

test('default runtime sends every ordinary input to the reasoning brain, never the fast classifier', async () => {
  const { bot, actions } = fixture('1.21.1'); actions.dispose(); bot.whisper = () => {};
  const calls: string[] = [];
  const runtime = new CompanionRuntime(bot, { owners: ['alice'],
    agent: { approvedPromptHash: brainPromptManifest().hash },
    brain: { fastLlm: { complete: async () => { assert.fail('fast classifier must not run'); } } },
    llm: { complete: async request => {
      const role = request.system.split('\n')[0]; calls.push(role);
      const text = JSON.parse(request.user).message?.text;
      assert.equal(role, 'SIM_AGENT_ROLE=decision');
      return text === '你好' ? '{"kind":"respond","text":"你好。"}'
        : '{"kind":"ask","question":"目标位置在哪里？","reason":"缺少依据"}';
    } } });
  try {
    assert.equal(runtime.agentMode, 'v2'); assert.ok(runtime.agentBrain);
    assert.ok(runtime.interaction instanceof AgentLoop);
    for (const [id, text] of ['你好', '背包有什么', '砍树', '把那个做完', '是的'].entries()) {
      await runtime.interaction.handle({ id: String(id), text, player: 'alice', receivedAt: Date.now() });
    }
    await runtime.interaction.whenIdle();
    assert.equal(calls.filter(role => role === 'SIM_AGENT_ROLE=decision').length, 5);
    assert.equal(calls.length, 5); // Each input is handled once, including ordinary chat.
    assert.equal(runtime.scheduler.list().length, 0);
  } finally { runtime.stop(); }
});

test('unreviewed runtime keeps local stop and pause available and sends no model request', async () => {
  const { bot, actions } = fixture('1.21.1'); actions.dispose(); bot.whisper = () => {};
  let calls = 0, stops = 0;
  const runtime = new CompanionRuntime(bot, { owners: ['alice'], agent: { approvedPromptHash: 'not-reviewed' },
    llm: { complete: async () => { calls++; return '{}'; } } });
  const stop = runtime.scheduler.stop.bind(runtime.scheduler);
  runtime.scheduler.stop = reason => { stops++; return stop(reason); };
  try {
    for (const [id, text] of ['砍树', '暂停', '停止'].entries()) {
      await runtime.interaction.handle({ id: String(id), text, player: 'alice', receivedAt: Date.now() });
    }
    assert.equal(calls, 0); assert.equal(stops, 2);
    assert.equal(runtime.scheduler.list().length, 0);
  } finally { runtime.stop(); }
});

test('default runtime advances an ordinary task through scheduler and evidence-based completion', async () => {
  const { bot, actions } = fixture('1.21.1'); actions.dispose(); bot.whisper = () => {};
  let proposed = false;
  const calls: string[] = [];
  const runtime = new CompanionRuntime(bot, { owners: ['alice'],
    agent: { approvedPromptHash: brainPromptManifest().hash },
    brain: { fastLlm: { complete: async () => { assert.fail('executor must default to the reasoning model'); } } },
    llm: { complete: async request => {
      const role = request.system.split('\n')[0].split('=')[1]; calls.push(role);
      const payload = JSON.parse(request.user);
      assert.equal(role, 'decision');
      if (payload.trigger === 'player_message') return JSON.stringify({ kind: 'goal', mode: 'new', objective: '等待片刻',
        criteria: [{ id: 'waited', text: '完成一次等待' }], assumptions: [] });
      if (!proposed) {
        proposed = true;
        return JSON.stringify({ kind: 'propose', purpose: '等待片刻', operations: [{ type: 'wait', durationMs: 1 }] });
      }
      assert.equal(payload.goal.originalRequest, '等待片刻');
      return JSON.stringify({ kind:'finish', assessment: { verdicts: [{ criterionId: 'waited', verdict: 'met',
        evidenceIds: [payload.freshEvidenceId], explanation: '模拟验收通过' }], omittedRequirements: [], summary: '等待已结束。' } });
    } } });
  try {
    assert.ok(runtime.interaction instanceof AgentLoop);
    await runtime.interaction.handle({ id: 'run', text: '等待片刻', player: 'alice', receivedAt: Date.now() });
    await runtime.interaction.whenIdle();
    assert.equal(runtime.interaction.snapshot.goal?.status, 'completed');
    assert.deepEqual(calls, ['decision', 'decision', 'decision']);
    assert.equal(runtime.scheduler.list().length, 1);
    assert.equal(runtime.scheduler.list()[0].state, 'completed');
  } finally { runtime.stop(); }
});
