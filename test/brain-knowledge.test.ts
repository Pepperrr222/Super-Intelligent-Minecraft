import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionBrain } from '../src/brain.js';
import { DecisionValidator, parseDecision } from '../src/brain-decision.js';
import type { LlmClient, LlmRequest } from '../src/llm.js';
import type { DecisionRequest } from '../src/brain-contract.js';
import { querySchema } from '../src/schema.js';

const request = (signal?: AbortSignal): DecisionRequest => ({ trigger: 'player_message', player: { name: 'alice', isOwner: true },
  message: { id: 'm', player: 'alice', text: '用云杉做木板', receivedAt: Date.now() },
  session: { player: 'alice', recent: [] }, signal });
const snapshot = { version: '1.21.1', inventory: [{ name: 'spruce_log', count: 3 }], entities: [] };

test('model can query knowledge, inspect structured results and submit an explicitly selected recipe', async () => {
  let turns = 0;
  const queries: unknown[] = [];
  const recipeRef = 'a'.repeat(64);
  const llm: LlmClient = { async complete(input: LlmRequest) {
    turns++;
    assert.ok(Buffer.byteLength(input.user, 'utf8') <= 12 * 1024);
    const context = JSON.parse(input.user);
    if (turns === 1) return JSON.stringify({ kind: 'query', query: { type: 'recipe_lookup', item: 'spruce_planks', limit: 1 } });
    assert.equal(context.knowledge[0].result.data.recipes[0].recipeRef, recipeRef);
    return JSON.stringify({ kind: 'skill', skill: 'craft_item', params: { item: 'spruce_planks', count: 4, recipeRef } });
  } };
  const brain = new CompanionBrain({ query(input) {
    const query = querySchema.parse(input);
    if (query.type === 'snapshot') return { status: 'succeeded', data: snapshot };
    queries.push(query);
    return { status: 'succeeded', data: { recipes: [{ recipeRef }] } };
  } }, { llm });
  const result = await brain.decide(request());
  assert.equal(result.kind, 'task');
  if (result.kind === 'task') assert.equal(result.task.steps[0]?.skill?.params.recipeRef, recipeRef);
  assert.equal(turns, 2);
  assert.equal(queries.length, 1);
});

test('only validated read-only knowledge queries are accepted as query decisions', () => {
  assert.equal(parseDecision(JSON.stringify({ kind: 'query', query: { type: 'requirements_expand', goals: [{ item: 'wooden_pickaxe', count: 1 }] } })).ok, true);
  for (const query of [{ type: 'dig', position: { x: 0, y: 0, z: 0 } },
    { type: 'recipe_lookup', item: 'x', limit: 100 },
    { type: 'requirements_expand', goals: [{ item: 'x', count: 1 }], maxDepth: 100 }]) {
    assert.equal(parseDecision(JSON.stringify({ kind: 'query', query })).ok, false);
  }
  // The validator also protects callers that bypass JSON parsing.
  assert.equal(new DecisionValidator().compile({ kind: 'query', query: { type: 'dig' } } as any, {} as any).kind, 'reject');
});

test('knowledge loop has a total call budget and rejects unchanged repeated queries', async () => {
  for (const repeated of [false, true]) {
    let turns = 0, reads = 0;
    const llm: LlmClient = { async complete() { turns++;
      return JSON.stringify({ kind: 'query', query: { type: 'recipe_lookup', item: 'spruce_planks', offset: repeated ? 0 : turns } });
    } };
    const brain = new CompanionBrain({ query(input) {
      if ((input as any).type === 'snapshot') return { status: 'succeeded', data: snapshot };
      reads++; return { status: 'succeeded', data: { recipes: [] } };
    } }, { llm });
    const result = await brain.decide(request());
    assert.equal(result.kind, 'reply');
    assert.equal(reads, repeated ? 1 : 3);
    assert.equal(turns, repeated ? 2 : 4);
  }
});

test('oversized knowledge is rejected structurally and the model can request a smaller page', async () => {
  let turns = 0;
  const llm: LlmClient = { async complete(input) {
    turns++;
    assert.ok(Buffer.byteLength(input.user, 'utf8') <= 12 * 1024);
    if (turns === 1) return JSON.stringify({ kind: 'query', query: { type: 'recipe_lookup', item: 'spruce_planks' } });
    assert.equal(JSON.parse(input.user).knowledge[0].result.error, 'OUTPUT_TOO_LARGE');
    return JSON.stringify({ kind: 'reply', text: '需要更小的查询页。' });
  } };
  const brain = new CompanionBrain({ query(input) { return { status: 'succeeded', data: (input as any).type === 'snapshot'
    ? snapshot : { recipes: [{ description: 'x'.repeat(20000) }] } }; } }, { llm });
  assert.equal((await brain.decide(request())).kind, 'reply');
  assert.equal(turns, 2);
});

test('stop after a late model query prevents knowledge access and task submission', async () => {
  const abort = new AbortController();
  let reads = 0;
  const brain = new CompanionBrain({ query(input) {
    if ((input as any).type !== 'snapshot') reads++;
    return { status: 'succeeded', data: snapshot };
  } }, { llm: { async complete() {
    abort.abort(new Error('stopped'));
    return JSON.stringify({ kind: 'query', query: { type: 'recipe_lookup', item: 'spruce_planks' } });
  } } });
  await assert.rejects(brain.decide(request(abort.signal)));
  assert.equal(reads, 0);
});
