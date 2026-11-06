import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BRAIN_LIMITS,
  buildBrainContext,
  buildSkillCards,
  contextBytes,
  summarizeObservation,
  truncateRunFeedback,
} from '../src/brain-context.js';
import type { RunFeedbackV1 } from '../src/brain-contract.js';
import type { SessionSnapshot } from '../src/interaction.js';

const rawSnapshot = {
  version: '1.21.1',
  dimension: 'minecraft:overworld',
  gameMode: 'survival',
  perceptionRadius: 16,
  position: { x: 0, y: 64, z: 0 },
  health: 20,
  food: 18,
  inventory: [
    { name: 'oak_log', count: 2, slot: 36, fingerprint: 'fp-secret', nbt: { secret: true }, customName: 'named' },
    { name: 'oak_log', count: 3, slot: 37 },
    { name: 'dirt', count: 1, slot: 38 },
  ],
  equipment: [
    { slot: 5, item: { name: 'iron_helmet', nbt: { hidden: true } } },
    { slot: 36, item: { name: 'oak_log' } },
  ],
  entities: [
    { id: 1, uuid: 'entity-uuid-secret', username: 'alice', type: 'player', position: { x: 3, y: 64, z: 4 }, metadata: { raw: true } },
    { id: 2, name: 'zombie', type: 'mob', position: { x: 0, y: 64, z: 10 } },
  ],
};

test('observation summary aggregates inventory and strips raw client data', () => {
  const summary = summarizeObservation(rawSnapshot, {}, 1000);
  assert.ok(summary);
  assert.deepEqual(summary.inventory, [
    { name: 'dirt', count: 1 },
    { name: 'oak_log', count: 5 },
  ]);
  assert.equal(summary.inventoryTruncated, false);
  assert.deepEqual(summary.equipped, [{ slot: 'head', name: 'iron_helmet' }]);
  assert.deepEqual(summary.entities.map(entity => ({ kind: entity.kind, name: entity.name, distance: entity.distance })), [
    { kind: 'player', name: 'alice', distance: 5 },
    { kind: 'mob', name: 'zombie', distance: 10 },
  ]);
  assert.deepEqual(summary.self, { position: { x: 0, y: 64, z: 0 }, health: 20, food: 18 });
  assert.equal(summary.observedAt, 1000);
  assert.equal(summary.version, '1.21.1');
  assert.equal(summary.perception.scope, 'loaded_client_chunks');
  assert.equal(summary.perception.completeWorldSearch, false);

  const serialized = JSON.stringify(summary);
  for (const forbidden of ['fingerprint', 'uuid', 'nbt', 'metadata', 'slot":36', 'customName']) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test('observation summary truncates inventory and entities with explicit flags', () => {
  const summary = summarizeObservation(rawSnapshot, { maxInventoryItems: 1, maxEntities: 1 });
  assert.ok(summary);
  assert.equal(summary.inventory.length, 1);
  assert.equal(summary.inventoryTruncated, true);
  assert.equal(summary.entities.length, 1);
  assert.equal(summary.entitiesTruncated, true);
});

test('observation summary is null when no snapshot is available', () => {
  assert.equal(summarizeObservation(undefined), null);
  assert.equal(summarizeObservation(null), null);
  assert.equal(summarizeObservation('not-a-snapshot'), null);
});

test('skill cards expose schema defaults, risk and availability', () => {
  const cards = buildSkillCards();
  assert.equal(cards.length, 10);
  assert.deepEqual(cards.map(card => card.id), [...cards.map(card => card.id)].sort());

  const craft = cards.find(card => card.id === 'craft_item');
  assert.ok(craft);
  assert.equal('$schema' in craft.params, false);
  const properties = craft.params.properties as Record<string, unknown>;
  assert.ok(properties.item);
  assert.ok(properties.count);
  const required = (craft.params.required as string[] | undefined) ?? [];
  assert.ok(required.includes('item'));
  assert.equal(required.includes('count'), false, 'defaulted fields stay optional');
  assert.equal(craft.requiresConfirmation, false);
  assert.equal(craft.available, true);

  const navigate = cards.find(card => card.id === 'navigate_to');
  assert.ok(navigate);
  assert.equal(navigate.requiresConfirmation, false);
  assert.ok(navigate.notes?.length);

  const gather = cards.find(card => card.id === 'gather_wood');
  assert.ok(gather);
  assert.equal(gather.idempotent, false);
  assert.ok(gather.notes?.some(note => note.includes('自动选择')));
  assert.equal(gather.requiresConfirmation, false);
});

test('skill cards disable unsupported versions and missing capabilities', () => {
  const oldVersion = buildSkillCards({ version: '1.20.4' });
  const gather = oldVersion.find(card => card.id === 'gather_wood');
  assert.equal(gather?.available, false);
  assert.match(gather?.unavailableReason ?? '', /1\.21\.1/);

  const legacy = oldVersion.find(card => card.id === 'report_inventory');
  assert.equal(legacy?.available, true);

  const limited = buildSkillCards({ capabilities: ['observe', 'navigate'] });
  assert.equal(limited.find(card => card.id === 'gather_wood')?.available, false);
  assert.equal(limited.find(card => card.id === 'craft_item')?.available, false);
  assert.equal(limited.find(card => card.id === 'navigate_to')?.available, true);
});

test('brain context carries bounded session, task and feedback summaries', () => {
  const now = 10_000;
  const session: SessionSnapshot = {
    player: 'alice',
    lastGoal: '砍 2 个橡木',
    pending: {
      kind: 'confirm',
      prompt: '要开始吗？',
      task: { id: 't', goal: 'gather_wood', steps: [{ id: 's1', actions: [] }] },
      createdAt: now - 100,
      expiresAt: now + 60_000,
    },
    recent: Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'player' as const : 'agent' as const,
      text: `消息 ${index}`,
      at: now - index * 100,
    })),
  };
  const currentTask = {
    id: 't1',
    goal: 'gather_wood',
    state: 'running' as const,
    currentStep: 1,
    totalSteps: 2,
    attempts: 1,
    priority: 10,
    dependsOn: [],
    submittedAt: now - 500,
    lastResult: {
      taskId: 't1',
      planRevision: 1,
      stepId: 's1',
      status: 'error' as const,
      partialEffects: [],
      leaseState: 'free' as const,
      error: { code: 'NO_TREE', message: '没有树' },
    },
  };
  const feedback: RunFeedbackV1 = {
    taskId: 't0',
    goal: '砍树',
    source: 'skill',
    outcome: 'failed',
    verified: false,
    finishedAt: now - 200,
    elapsedMs: 200,
    steps: Array.from({ length: 20 }, (_, index) => ({
      stepId: `s${index}`,
      skill: 'gather_wood',
      status: 'error' as const,
      evidence: null,
      error: { code: 'NO_TREE', message: '没有树' },
      output: { collected: 0 },
    })),
    verifiedChanges: { inventory: [], containers: [], position: null },
    sideEffects: Array.from({ length: 20 }, (_, index) => `effect-${index}`),
    retryable: true,
    repeatedFailure: false,
  };

  const context = buildBrainContext({
    trigger: 'player_message',
    player: { name: 'alice', isOwner: true },
    message: { id: 'm', player: 'alice', text: '砍树', receivedAt: now, channel: 'chat' },
    session,
    currentTask,
    lastRun: feedback,
    snapshot: rawSnapshot,
    now,
  }, { maxRecent: 3 });

  assert.equal(context.schema, 'sim.brain.v1');
  assert.equal(context.message?.text, '砍树');
  assert.equal(context.session.recent.length, 3);
  assert.equal(context.session.pending?.kind, 'confirm');
  assert.equal(context.session.lastGoal, '砍 2 个橡木');
  assert.deepEqual(context.currentTask, {
    id: 't1',
    goal: 'gather_wood',
    state: 'running',
    currentStep: 1,
    totalSteps: 2,
    attempts: 1,
    lastStatus: 'error',
    lastErrorCode: 'NO_TREE',
  });
  assert.equal(context.lastRun?.steps.length, 12);
  assert.equal(context.lastRun?.sideEffects.length, 12);
  assert.equal(context.observation?.inventory.find(item => item.name === 'oak_log')?.count, 5);
  assert.equal(context.limits.maxPlanSteps, DEFAULT_BRAIN_LIMITS.maxPlanSteps);
  assert.equal(context.truncated, undefined);
});

test('brain context has no observation when the snapshot is unavailable', () => {
  const context = buildBrainContext({
    trigger: 'player_message',
    player: { name: 'alice', isOwner: false },
    message: { id: 'm', player: 'alice', text: '你好', receivedAt: 1 },
    session: { player: 'alice', recent: [] },
    now: 1,
  });
  assert.equal(context.observation, null);
  assert.equal(context.player.isOwner, false);
  assert.equal(context.lastRun, null);
});

test('brain context trims to the byte budget and keeps skill cards', () => {
  const inventory = Array.from({ length: 100 }, (_, index) => ({
    name: `item_${index}`,
    count: index + 1,
    fingerprint: `fp-${index}`,
    nbt: { index },
  }));
  const entities = Array.from({ length: 50 }, (_, index) => ({
    id: index + 1,
    uuid: `uuid-${index}`,
    username: index % 2 === 0 ? `player_${index}` : undefined,
    name: `entity_${index}`,
    type: 'mob',
    position: { x: index, y: 64, z: 0 },
  }));
  const recent = Array.from({ length: 30 }, (_, index) => ({
    role: 'player' as const,
    text: `很长的历史消息 ${index} `.repeat(20),
    at: index,
  }));
  const context = buildBrainContext({
    trigger: 'player_message',
    player: { name: 'alice', isOwner: true },
    message: { id: 'm', player: 'alice', text: '看看周围', receivedAt: 99_999 },
    session: { player: 'alice', recent },
    snapshot: { ...rawSnapshot, inventory, entities },
    now: 100_000,
  }, { maxContextBytes: 9000 });

  assert.equal(context.truncated, true);
  assert.ok(contextBytes(context) <= 9000);
  assert.equal(context.availableSkills.length, 10);
  assert.equal((context.observation?.inventory.length ?? 0) <= DEFAULT_BRAIN_LIMITS.maxInventoryItems, true);
  assert.equal((context.observation?.entities.length ?? 0) <= DEFAULT_BRAIN_LIMITS.maxEntities, true);
  assert.equal(JSON.stringify(context).includes('fp-0'), false);
  assert.equal(JSON.stringify(context).includes('uuid-0'), false);
});

test('truncateRunFeedback bounds every collection', () => {
  const feedback: RunFeedbackV1 = {
    taskId: 't',
    goal: 'x'.repeat(500),
    source: 'plan',
    outcome: 'partial',
    verified: false,
    finishedAt: 1,
    elapsedMs: 1,
    steps: Array.from({ length: 20 }, (_, index) => ({
      stepId: `s${index}`,
      skill: 'gather_wood',
      status: 'partial' as const,
      evidence: null,
      error: { code: 'E'.repeat(200), message: 'm'.repeat(500) },
      output: { long: 'o'.repeat(2000) },
    })),
    verifiedChanges: {
      inventory: Array.from({ length: 100 }, (_, index) => ({ item: `item_${index}`, delta: 1 })),
      containers: Array.from({ length: 30 }, (_, index) => ({ position: { x: index, y: 0, z: 0 }, item: 'x', delta: 1 })),
      position: null,
    },
    sideEffects: Array.from({ length: 30 }, (_, index) => `effect-${index}`.repeat(100)),
    retryable: true,
    repeatedFailure: true,
  };
  const bounded = truncateRunFeedback(feedback);
  assert.equal(bounded.goal?.length, 300);
  assert.equal(bounded.steps.length, 12);
  assert.equal(bounded.steps[0]?.error?.code.length, 100);
  assert.equal(bounded.steps[0]?.error?.message.length, 300);
  assert.equal(bounded.steps[0]?.output?.truncated, true);
  assert.equal(typeof bounded.steps[0]?.output?.summary, 'string');
  assert.equal((bounded.steps[0]?.output?.summary as string).length, 500);
  assert.equal(bounded.verifiedChanges.inventory.length, 64);
  assert.equal(bounded.verifiedChanges.containers.length, 16);
  assert.equal(bounded.sideEffects.length, 12);
});
