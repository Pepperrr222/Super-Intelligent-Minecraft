import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionBrain } from '../src/brain.js';
import type { BrainInput, SessionSnapshot } from '../src/interaction.js';
import type { LlmClient, LlmRequest } from '../src/llm.js';
import type { QueryOutcome } from '../src/task.js';

class FakeLlm implements LlmClient {
  calls: LlmRequest[] = [];
  response: string | (() => Promise<string>) = '{}';

  async complete(request: LlmRequest): Promise<string> {
    this.calls.push(request);
    return typeof this.response === 'string' ? this.response : this.response();
  }
}

const session: SessionSnapshot = { player: 'alice', recent: [] };
const observations = {
  query: (): QueryOutcome => ({
    status: 'succeeded',
    data: {
      position: { x: 0, y: 64, z: 0 },
      inventory: [{ name: 'oak_log', count: 3 }],
      entities: [{ id: 7, username: 'alice', position: { x: 2, y: 64, z: 2 } }],
    },
  }),
};

function input(intent: BrainInput['intent'], text: string): BrainInput {
  return {
    message: { id: 'm1', player: 'alice', text, receivedAt: Date.now(), channel: 'chat' },
    intent,
    session,
  };
}

test('LLM task plans are validated and returned as Tasks', async () => {
  const llm = new FakeLlm();
  llm.response = JSON.stringify({
    kind: 'task',
    goal: '拿木头',
    ack: '去拿。',
    steps: [{
      id: 's1',
      actions: [{ type: 'navigate', position: { x: 2, y: 64, z: 2 }, range: 2 }],
    }],
  });
  const brain = new CompanionBrain(observations, { llm });

  const result = await brain.handle(input({ kind: 'task', goal: '帮我拿点木头' }, '帮我拿点木头'));

  assert.equal(result.kind, 'task');
  if (result.kind === 'task') {
    assert.equal(result.ack, '去拿。');
    assert.equal(result.task.steps[0]?.actions[0]?.type, 'navigate');
    assert.equal(result.confirmation, undefined);
  }
  assert.equal(llm.calls.length, 1);
});

test('LLM flat coordinates are normalized into nested action positions', async () => {
  const llm = new FakeLlm();
  llm.response = JSON.stringify({
    kind: 'task',
    steps: [{
      id: 's1',
      actions: [{ type: 'navigate', x: 2, y: 64, z: 2 }],
    }],
  });
  const brain = new CompanionBrain(observations, { llm });

  const result = await brain.handle(input({ kind: 'task', goal: '走到坐标 2 64 2' }, '走到坐标 2 64 2'));

  assert.equal(result.kind, 'task');
  if (result.kind === 'task') {
    const action = result.task.steps[0]?.actions[0];
    assert.equal(action?.type, 'navigate');
    if (action?.type === 'navigate') assert.deepEqual(action.position, { x: 2, y: 64, z: 2 });
  }
});

test('LLM multi-step or destructive plans require confirmation', async () => {
  const llm = new FakeLlm();
  llm.response = JSON.stringify({
    kind: 'task',
    steps: [
      { id: 's1', actions: [{ type: 'navigate', position: { x: 1, y: 64, z: 1 }, range: 1 }] },
      { id: 's2', actions: [{ type: 'dig', position: { x: 1, y: 64, z: 1 } }] },
    ],
  });
  const brain = new CompanionBrain(observations, { llm });

  const result = await brain.handle(input({ kind: 'task', goal: '处理一下' }, '处理一下'));

  assert.equal(result.kind, 'task');
  if (result.kind === 'task') assert.match(result.confirmation ?? '', /要开始吗/);
});

test('invalid LLM actions are rejected instead of reaching the scheduler', async () => {
  const llm = new FakeLlm();
  llm.response = JSON.stringify({
    kind: 'task',
    steps: [{ id: 's1', actions: [{ type: 'teleport', position: { x: 0, y: 0, z: 0 } }] }],
  });
  const brain = new CompanionBrain(observations, { llm });

  const result = await brain.handle(input({ kind: 'task', goal: '瞬移' }, '瞬移'));

  assert.equal(result.kind, 'clarify');
  if (result.kind === 'clarify') assert.match(result.question, /动作校验/);
});

test('LLM chat replies are parsed from JSON', async () => {
  const llm = new FakeLlm();
  llm.response = JSON.stringify({ kind: 'reply', text: '你好，我是伙伴。' });
  const brain = new CompanionBrain(observations, { llm });

  const result = await brain.handle(input({ kind: 'chat', text: '你是谁' }, '你是谁'));

  assert.deepEqual(result, { kind: 'reply', text: '你好，我是伙伴。' });
});

test('LLM failures fall back to deterministic behavior', async () => {
  const llm = new FakeLlm();
  llm.response = async () => { throw new Error('network down'); };
  const brain = new CompanionBrain(observations, { llm });

  const chat = await brain.handle(input({ kind: 'chat', text: '你好' }, '你好'));
  assert.equal(chat.kind, 'reply');

  const task = await brain.handle(input({ kind: 'task', goal: '建个房子' }, '建个房子'));
  assert.equal(task.kind, 'clarify');
});
