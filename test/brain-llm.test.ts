import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionBrain } from '../src/brain.js';
import { PlanValidator } from '../src/planner.js';
import { RuleBasedIntentClassifier, InteractionService, type ChatTransport, type PlayerMessage } from '../src/interaction.js';
import type { LlmClient, LlmRequest } from '../src/llm.js';
import type { ControllerPort, Task, TaskSnapshot } from '../src/task.js';

class FakeLlm implements LlmClient {
  calls: LlmRequest[] = []; response: string | (() => Promise<string>) = '{}';
  async complete(request: LlmRequest) { this.calls.push(request); return typeof this.response === 'string' ? this.response : this.response(); }
}
const snapshot = { position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'oak_log', count: 3 }], entities: [{ id: 7, username: 'alice', position: { x: 2, y: 64, z: 2 } }] };
const observations = { query: () => ({ status: 'succeeded', data: snapshot }) };
const msg = (text: string, id = text): PlayerMessage => ({ id, player: 'alice', text, receivedAt: Date.now() });
const plan = () => ({ id: 'p', goalId: 'g', revision: 0, nodes: [{ id: 'a', skill: 'navigate_to', params: { x: 2, y: 64, z: 2 }, preconditions: [], postconditions: [], idempotent: true }], edges: [], milestones: [], assumptions: [], budget: { maxSteps: 2, maxSeconds: 60 } });
const input = (intent: any, text: string) => ({ message: msg(text), intent, session: { player: 'alice', recent: [] } });

test('English and Chinese follow aliases compile the same validated action without LLM', async () => {
  const llm = new FakeLlm(); const brain = new CompanionBrain(observations, { llm }); const router = new RuleBasedIntentClassifier();
  const outputs = await Promise.all(['follow me', '跟着我'].map(async text => brain.handle(input((await router.classify({ message: msg(text) })).intent, text))));
  assert.equal(outputs[0]?.kind, 'task'); assert.equal(outputs[1]?.kind, 'task');
  if (outputs[0]?.kind === 'task' && outputs[1]?.kind === 'task') assert.deepEqual(outputs[0].task.steps[0]?.actions, outputs[1].task.steps[0]?.actions);
  assert.equal(llm.calls.length, 0);
});
test('coordinates and inventory are deterministic and unknown player is clarified', async () => {
  const llm = new FakeLlm(); const brain = new CompanionBrain(observations, { llm }); const router = new RuleBasedIntentClassifier();
  for (const text of ['走到坐标 2 64 2', '背包里有什么']) {
    const result = await brain.handle(input((await router.classify({ message: msg(text) })).intent, text));
    assert.equal(result.kind, text.startsWith('走') ? 'task' : 'reply');
  }
  const missing = new CompanionBrain({ query: () => ({ status: 'succeeded', data: { entities: [] } }) }, { llm });
  assert.equal((await missing.handle(input({ kind: 'skill', skill: 'follow_player', params: {} }, 'follow me'))).kind, 'clarify');
  assert.equal(llm.calls.length, 0);
});
test('planner accepts only validated skill graphs and rejects cycles, unknown skills and action payloads', () => {
  const validator = new PlanValidator(); const ctx = { player: 'alice', snapshot };
  assert.ok('task' in validator.compile(plan(), ctx, 'go'));
  const cycle = plan(); cycle.edges = [{ from: 'a', to: 'a' }] as never[];
  assert.ok('error' in validator.compile(cycle, ctx, 'go'));
  const unknown = plan(); unknown.nodes[0]!.skill = 'teleport';
  assert.ok('error' in validator.compile(unknown, ctx, 'go'));
  const action = plan(); (action.nodes[0] as any).actions = [{ type: 'dig' }];
  assert.ok('error' in validator.compile(action, ctx, 'go'));
  const invented = plan(); invented.nodes[0]!.params = { x: 90, y: 64, z: 90 };
  assert.ok('error' in validator.compile(invented, ctx, 'go'));
  const budget = plan(); budget.budget.maxSeconds = 0;
  assert.ok('error' in validator.compile(budget, ctx, 'go'));
});
test('multi-step plan is compiled in dependency order and requires confirmation', () => {
  const p = plan(); p.nodes.push({ ...p.nodes[0]!, id: 'b' }); p.edges = [{ from: 'b', to: 'a' }] as never[];
  const result = new PlanValidator().compile(p, { player: 'alice', snapshot }, 'go');
  assert.ok('task' in result); if ('task' in result) { assert.deepEqual(result.task.steps.map(s => s.id), ['b', 'a']); assert.ok(result.confirmation); }
});
test('chat has bounded history and templates skip the model', async () => {
  const llm = new FakeLlm(); llm.response = JSON.stringify({ kind: 'reply', text: '我是伙伴。' }); const brain = new CompanionBrain(observations, { llm });
  await brain.handle(input({ kind: 'chat', text: '你好' }, '你好')); assert.equal(llm.calls.length, 0);
  assert.equal((await brain.handle(input({ kind: 'chat', text: '你是谁' }, '你是谁'))).kind, 'reply');
  assert.equal(llm.calls[0]?.maxTokens, 250); assert.doesNotMatch(llm.calls[0]?.user ?? '', /inventory/);
});
test('stop aborts planning and discards a late result while chat remains responsive', async () => {
  let resolve!: (value: string) => void; const llm = new FakeLlm(); llm.response = () => new Promise(r => { resolve = r; });
  const sent: string[] = []; const transport: ChatTransport = { onMessage: () => () => {}, send: (_p, text) => { sent.push(text); } };
  const submitted: Task[] = []; let stopped = 0;
  const scheduler = { submit: (task: Task) => { submitted.push(task); return {} as TaskSnapshot; }, get: () => undefined, list: () => [], pause: () => 0, resume: () => 0, cancel: () => false, stop: () => { stopped++; } };
  const controller = { busy: false, stop: () => {}, execute: async () => { throw new Error('unexpected'); } } as ControllerPort;
  const service = new InteractionService(transport, new RuleBasedIntentClassifier(), new CompanionBrain(observations, { llm }), scheduler, controller, undefined, { owners: ['alice'], autoRun: false, rateLimit: { windowMs: 10000, max: 2 } });
  await service.handle(msg('建个房子', '1')); assert.match(sent[0]!, /规划/); assert.equal(llm.calls.length, 1);
  await service.handle(msg('你好', '2')); assert.match(sent.at(-1)!, /你好/);
  await service.handle(msg('停', '3')); assert.equal(stopped, 1); assert.equal(llm.calls[0]?.signal?.aborted, true);
  resolve(JSON.stringify({ kind: 'plan', plan: plan() })); await new Promise(r => setImmediate(r));
  assert.equal(submitted.length, 0); assert.equal(sent.at(-1), '已停。');
});

test('a newer movement goal cancels in-flight planning and wins over its late answer', async () => {
  let resolve!: (value: string) => void; const llm = new FakeLlm(); llm.response = () => new Promise(r => { resolve = r; });
  const sent: string[] = []; const transport: ChatTransport = { onMessage: () => () => {}, send: (_p, text) => { sent.push(text); } };
  const submitted: Task[] = [];
  const scheduler = { submit: (task: Task) => { submitted.push(task); return {} as TaskSnapshot; }, get: () => undefined, list: () => [], pause: () => 0, resume: () => 0, cancel: () => false, stop: () => {} };
  const controller = { busy: false, stop: () => {}, execute: async () => { throw new Error('unexpected'); } } as ControllerPort;
  const service = new InteractionService(transport, new RuleBasedIntentClassifier(), new CompanionBrain(observations, { llm }), scheduler, controller, undefined, { owners: ['alice'], autoRun: false });
  await service.handle(msg('建个房子', '1')); await service.handle(msg('follow me', '2'));
  resolve(JSON.stringify({ kind: 'plan', plan: plan() })); await new Promise(r => setImmediate(r));
  assert.equal(submitted.length, 1); assert.equal(submitted[0]?.steps[0]?.actions[0]?.type, 'follow'); assert.equal(llm.calls[0]?.signal?.aborted, true);
});
