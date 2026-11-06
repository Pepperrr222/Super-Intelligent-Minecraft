import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalManager } from '../src/goals.js';
import type { RunFeedbackV1 } from '../src/brain-contract.js';
import type { FailureEntry } from '../src/brain-feedback.js';

function feedback(outcome: RunFeedbackV1['outcome'], overrides: Partial<RunFeedbackV1> = {}): RunFeedbackV1 {
  return {
    taskId: 't',
    goal: 'gather_wood',
    source: 'skill',
    outcome,
    verified: outcome === 'completed',
    finishedAt: 1000,
    elapsedMs: 100,
    steps: [],
    verifiedChanges: { inventory: [], containers: [], position: null },
    sideEffects: [],
    retryable: outcome === 'failed' || outcome === 'timeout' || outcome === 'partial',
    repeatedFailure: false,
    ...overrides,
  };
}

const entry: FailureEntry = {
  call: 'gather_wood:{"count":1}',
  failure: 'gather_wood:{"count":1}:NO_TREE',
  code: 'NO_TREE',
};

test('only one goal can be active and new goals wait for a terminal state', () => {
  const goals = new GoalManager();
  const started = goals.begin({ owner: 'alice', sourceText: '砍树', goal: 'gather_wood', now: 100 });
  assert.ok(started);
  assert.equal(goals.active?.goalId, started.goalId);
  assert.equal(goals.begin({ owner: 'alice', sourceText: '再做木板', goal: 'craft_item', now: 200 }), undefined);
  assert.equal(goals.active?.sourceText, '砍树');
});

test('turn budget stops after six follow-up decisions', () => {
  const goals = new GoalManager();
  goals.begin({ owner: 'alice', sourceText: '砍树', goal: 'gather_wood' });
  for (let index = 0; index < 6; index++) assert.equal(goals.turn(), true, `turn ${index + 1}`);
  assert.equal(goals.turn(), false);
});

test('replans are capped at two and counted on the revision', () => {
  const goals = new GoalManager();
  goals.begin({ owner: 'alice', sourceText: '砍树', goal: 'gather_wood' });
  assert.equal(goals.canReplan(), true);
  assert.equal(goals.noteReplan(), true);
  assert.equal(goals.noteReplan(), true);
  assert.equal(goals.state?.replans, 2);
  assert.equal(goals.state?.planRevision, 2);
  assert.equal(goals.canReplan(), false);
  assert.equal(goals.noteReplan(), false);
});

test('the same call is blocked after failing twice with the same code', () => {
  const goals = new GoalManager();
  goals.begin({ owner: 'alice', sourceText: '砍树', goal: 'gather_wood' });

  const first = goals.record(feedback('failed'), [entry], [entry.call]);
  assert.equal(first.repeatedFailure, false);
  assert.deepEqual(goals.blockedCalls(), []);

  const second = goals.record(feedback('failed'), [entry], [entry.call]);
  assert.equal(second.repeatedFailure, true);
  assert.deepEqual(goals.blockedCalls(), [entry.call]);

  const third = goals.record(feedback('failed'), [entry], [entry.call]);
  assert.deepEqual(third.repeatedFailure, true);
  assert.deepEqual(goals.blockedCalls(), [entry.call]);
});

test('a completed run clears earlier failure counts for the same calls', () => {
  const goals = new GoalManager();
  goals.begin({ owner: 'alice', sourceText: '砍树', goal: 'gather_wood' });
  goals.record(feedback('failed'), [entry], [entry.call]);
  goals.record(feedback('failed'), [entry], [entry.call]);
  assert.equal(goals.blockedCalls().length, 1);

  const completed = goals.record(feedback('completed'), [], [entry.call]);
  assert.equal(completed.repeatedFailure, false);
  assert.deepEqual(goals.blockedCalls(), []);
  assert.equal(goals.active, undefined);
});

test('failed, blocked and cancelled feedback map to goal status', () => {
  const goals = new GoalManager();
  goals.begin({ owner: 'alice', sourceText: '砍树', goal: 'gather_wood' });
  goals.record(feedback('failed'));
  assert.equal(goals.state?.status, 'failed');
  assert.ok(goals.active);

  goals.record(feedback('blocked'));
  assert.equal(goals.state?.status, 'blocked');

  goals.record(feedback('timeout'));
  assert.equal(goals.state?.status, 'failed');

  goals.record(feedback('partial'));
  assert.equal(goals.state?.status, 'partial');

  goals.record(feedback('cancelled'));
  assert.equal(goals.active, undefined);
});

test('finish closes a goal so a new player goal can begin', () => {
  const goals = new GoalManager();
  goals.begin({ owner: 'alice', sourceText: '砍树', goal: 'gather_wood' });
  goals.record(feedback('failed'));
  assert.ok(goals.active);
  goals.finish('failed');
  assert.equal(goals.active, undefined);
  assert.equal(goals.state, undefined);
  assert.ok(goals.begin({ owner: 'alice', sourceText: '新目标', goal: 'craft_item' }));
});

test('reset forgets the goal and failure history', () => {
  const goals = new GoalManager();
  goals.begin({ owner: 'alice', sourceText: '砍树', goal: 'gather_wood' });
  goals.record(feedback('failed'), [entry], [entry.call]);
  goals.record(feedback('failed'), [entry], [entry.call]);
  goals.reset();
  assert.equal(goals.state, undefined);
  assert.deepEqual(goals.blockedCalls(), []);
  const next = goals.begin({ owner: 'alice', sourceText: '砍树', goal: 'gather_wood' });
  assert.ok(next);
  assert.deepEqual(next.failures, {});
});

test('record without an active goal returns the feedback unchanged', () => {
  const goals = new GoalManager();
  const input = feedback('failed');
  assert.deepEqual(goals.record(input, [entry], [entry.call]), input);
});
