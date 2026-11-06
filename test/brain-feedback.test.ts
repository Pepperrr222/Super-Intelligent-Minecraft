import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunFeedback,
  callKey,
  describeFeedback,
  failureEntries,
  failureKey,
  itemLabel,
  stableStringify,
} from '../src/brain-feedback.js';
import type { ControllerResult, Task, TaskSnapshot, TaskState } from '../src/task.js';

function task(id: string, skillId: string, params: Record<string, unknown>, goal = skillId): Task {
  return {
    id,
    goal,
    steps: [{ id: `${id}-step`, actions: [], skill: { id: skillId, params } }],
    metadata: { source: 'skill' },
  };
}

function result(status: ControllerResult['status'], output: unknown, extra: Partial<ControllerResult> = {}): ControllerResult {
  return {
    taskId: 't',
    planRevision: 1,
    stepId: 't-step',
    status,
    evidence: status === 'ok' ? 'step_verified' : 'client_observed',
    data: { output, partialEffects: [] },
    partialEffects: [],
    leaseState: 'free',
    ...extra,
  };
}

function snapshot(state: TaskState, results: ControllerResult[], submittedAt = 1000): TaskSnapshot {
  return {
    id: 't',
    goal: 'gather_wood',
    state,
    currentStep: results.length,
    totalSteps: 1,
    attempts: 0,
    priority: 10,
    dependsOn: [],
    submittedAt,
    lastResult: results.at(-1),
    stepResults: results,
  };
}

test('completed gather reports verified inventory gain', () => {
  const feedback = buildRunFeedback({
    task: task('t', 'gather_wood', { woodType: 'oak_log', count: 2 }, '砍 2 个橡木'),
    snapshot: snapshot('completed', [result('ok', { requested: 2, collected: 2, woodType: 'oak_log' })]),
    startedAt: 500,
    now: 1000,
  });

  assert.equal(feedback.outcome, 'completed');
  assert.equal(feedback.verified, true);
  assert.equal(feedback.source, 'skill');
  assert.equal(feedback.elapsedMs, 500);
  assert.equal(feedback.retryable, false);
  assert.deepEqual(feedback.verifiedChanges.inventory, [{ item: 'oak_log', delta: 2 }]);
  assert.match(describeFeedback(feedback), /完成：获得 2 个 橡木原木/);
});

test('completed without step verification is not claimed as verified', () => {
  const feedback = buildRunFeedback({
    task: task('t', 'gather_wood', { count: 1 }),
    snapshot: snapshot('completed', [result('ok', { requested: 1, collected: 1 }, { evidence: 'client_observed' })]),
  });
  assert.equal(feedback.outcome, 'completed');
  assert.equal(feedback.verified, false);
  assert.match(describeFeedback(feedback), /没有观测到可确认的变化/);
});

test('partial harvest reports the gap, not success', () => {
  const feedback = buildRunFeedback({
    task: task('t', 'gather_wood', { count: 3 }),
    snapshot: snapshot('failed', [
      result('partial', { requested: 3, collected: 1 }, {
        error: { code: 'NO_CANDIDATE', message: '只找到一棵树' },
      }),
    ]),
  });
  assert.equal(feedback.outcome, 'partial');
  assert.equal(feedback.verified, false);
  assert.equal(feedback.retryable, true);
  assert.match(describeFeedback(feedback), /未完成：获得 1\/3 个/);
});

test('blocked, timeout and failed outcomes have deterministic text', () => {
  const blocked = buildRunFeedback({
    task: task('t', 'store_items', { container: { x: 0, y: 64, z: 0 }, item: 'oak_log', count: 1 }),
    snapshot: snapshot('blocked', [
      result('blocked', null, { error: { code: 'NO_CONTAINER', message: '箱子不存在' } }),
    ]),
  });
  assert.equal(blocked.outcome, 'blocked');
  assert.match(describeFeedback(blocked), /没能开始：箱子不存在/);

  const timeout = buildRunFeedback({
    task: task('t', 'navigate_to', { x: 2, y: 64, z: 2 }),
    snapshot: snapshot('failed', [
      result('timeout', null, { error: { code: 'TIMEOUT', message: '没有在预算内到达' } }),
    ]),
  });
  assert.equal(timeout.outcome, 'timeout');
  assert.match(describeFeedback(timeout), /超时：没有在预算内到达/);

  const failed = buildRunFeedback({
    task: task('t', 'gather_wood', { count: 1 }),
    snapshot: snapshot('failed', [
      result('error', null, { error: { code: 'NO_TREE', message: '附近没有带树叶的橡木' } }),
    ]),
  });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.retryable, true);
  assert.match(describeFeedback(failed), /失败：附近没有带树叶的橡木/);
});

test('cancelled feedback reports partial effects and never claims completion', () => {
  const feedback = buildRunFeedback({
    task: task('t', 'gather_wood', { count: 2 }),
    snapshot: snapshot('cancelled', [
      result('cancelled', null, {
        evidence: undefined,
        data: { partialEffects: ['已挖开 oak_log (1,64,1)'] },
        error: { code: 'CANCELLED', message: '玩家停止' },
      }),
    ]),
  });
  assert.equal(feedback.outcome, 'cancelled');
  assert.equal(feedback.verified, false);
  assert.deepEqual(feedback.sideEffects, ['已挖开 oak_log (1,64,1)']);
  assert.match(describeFeedback(feedback), /已取消。已发生：已挖开 oak_log/);
});

test('craft, store, deliver and navigate outputs become verified changes', () => {
  const craft = buildRunFeedback({
    task: task('t', 'craft_item', { item: 'oak_planks', count: 4 }),
    snapshot: snapshot('completed', [result('ok', { requested: 4, crafted: 4, item: 'oak_planks' })]),
  });
  assert.equal(craft.verified, true);
  assert.deepEqual(craft.verifiedChanges.inventory, [{ item: 'oak_planks', delta: 4 }]);
  assert.match(describeFeedback(craft), /完成：获得 4 个 橡木木板/);

  const store = buildRunFeedback({
    task: task('t', 'store_items', { container: { x: 0, y: 64, z: 0 }, item: 'oak_log', count: 3 }),
    snapshot: snapshot('completed', [result('ok', {
      inventoryBefore: 10,
      inventoryAfter: 7,
      containerBefore: 0,
      containerAfter: 3,
      item: 'oak_log',
      container: { x: 0, y: 64, z: 0 },
    })]),
  });
  assert.equal(store.verified, true);
  assert.deepEqual(store.verifiedChanges.inventory, [{ item: 'oak_log', delta: -3 }]);
  assert.deepEqual(store.verifiedChanges.containers, [
    { position: { x: 0, y: 64, z: 0 }, item: 'oak_log', delta: 3 },
  ]);
  assert.match(describeFeedback(store), /完成：存入 3 个 橡木原木/);

  const deliver = buildRunFeedback({
    task: task('t', 'deliver_to_player', { item: 'oak_log', count: 3, player: 'alice' }),
    snapshot: snapshot('completed', [result('ok', { requested: 3, tossed: 3, item: 'oak_log', receipt: 'unverified' })]),
  });
  assert.equal(deliver.verified, true);
  assert.deepEqual(deliver.verifiedChanges.inventory, [{ item: 'oak_log', delta: -3 }]);
  assert.ok(deliver.sideEffects.some(effect => effect.includes('客户端无法确认对方拾取')));
  assert.match(describeFeedback(deliver), /完成：交付了 3 个 橡木原木；客户端无法确认对方是否拾取/);

  const navigate = buildRunFeedback({
    task: task('t', 'navigate_to', { x: 2, y: 64, z: 2 }),
    snapshot: snapshot('completed', [result('ok', {
      target: { x: 2, y: 64, z: 2 },
      positionBefore: { x: 0, y: 64, z: 0 },
      positionAfter: { x: 2, y: 64, z: 2 },
      distanceAfter: 0,
      range: 2,
    })]),
  });
  assert.equal(navigate.verified, true);
  assert.deepEqual(navigate.verifiedChanges.position, {
    before: { x: 0, y: 64, z: 0 },
    after: { x: 2, y: 64, z: 2 },
    target: { x: 2, y: 64, z: 2 },
    range: 2,
  });
  assert.match(describeFeedback(navigate), /完成：已到达目标附近/);
});

test('action-only follow is not a verified world change, come_to_player is', () => {
  const actionResult = (stepId: string, data: unknown): ControllerResult => ({
    taskId: 't',
    planRevision: 1,
    stepId,
    status: 'ok',
    evidence: 'step_verified',
    data,
    partialEffects: [],
    leaseState: 'free',
  });

  const followTask: Task = {
    id: 't',
    goal: 'follow_player',
    steps: [{ id: 'follow', actions: [{ type: 'follow', entityId: 1, distance: 2, durationMs: 30_000 }] }],
    metadata: { source: 'plan' },
  };
  const follow = buildRunFeedback({
    task: followTask,
    snapshot: snapshot('completed', [actionResult('follow', {
      evidence: 'follow_interval_elapsed',
      distance: 1.5,
      durationMs: 30_000,
    })]),
  });
  assert.equal(follow.outcome, 'completed');
  assert.equal(follow.verified, false);
  assert.match(describeFeedback(follow), /没有观测到可确认的变化/);

  const comeTask: Task = {
    id: 't',
    goal: 'come_to_player',
    steps: [{ id: 'come', actions: [{ type: 'navigate', position: { x: 2, y: 64, z: 2 }, range: 2 }] }],
    metadata: { source: 'plan' },
  };
  const come = buildRunFeedback({
    task: comeTask,
    snapshot: snapshot('completed', [actionResult('come', {
      evidence: 'position_observed',
      position: { x: 2, y: 64, z: 2 },
    })]),
  });
  assert.equal(come.outcome, 'completed');
  assert.equal(come.verified, true);
  assert.match(describeFeedback(come), /完成/);
});

test('a fallen follow-up step is reported as not_run', () => {
  const taskWithSteps: Task = {
    id: 't',
    steps: [
      { id: 'first', actions: [], skill: { id: 'gather_wood', params: { count: 1 } } },
      { id: 'second', actions: [], skill: { id: 'craft_item', params: { item: 'stick', count: 1 } } },
    ],
  };
  const feedback = buildRunFeedback({
    task: taskWithSteps,
    snapshot: {
      ...snapshot('failed', [result('error', null, { stepId: 'first', error: { code: 'NO_TREE', message: '没有树' } })]),
      totalSteps: 2,
    },
  });
  assert.deepEqual(feedback.steps.map(step => step.status), ['error', 'not_run']);
  assert.equal(feedback.source, 'plan');
});

test('failure keys and stable params are deterministic', () => {
  assert.equal(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  assert.equal(callKey('navigate_to', { z: 2, x: 1, y: 3 }), 'navigate_to:{"x":1,"y":3,"z":2}');
  assert.equal(failureKey('gather_wood', { count: 1 }, 'NO_TREE'), 'gather_wood:{"count":1}:NO_TREE');

  const feedback = buildRunFeedback({
    task: task('t', 'gather_wood', { count: 1 }),
    snapshot: snapshot('failed', [
      result('error', null, { error: { code: 'NO_TREE', message: '没有树' } }),
    ]),
  });
  const entries = failureEntries(task('t', 'gather_wood', { count: 1 }), feedback);
  assert.deepEqual(entries, [{
    call: 'gather_wood:{"count":1}',
    failure: 'gather_wood:{"count":1}:NO_TREE',
    code: 'NO_TREE',
  }]);
});

test('itemLabel localizes known items and falls back to registry ids', () => {
  assert.equal(itemLabel('oak_log'), '橡木原木');
  assert.equal(itemLabel('unknown_item'), 'unknown_item');
  assert.equal(itemLabel(null), '物品');
});
