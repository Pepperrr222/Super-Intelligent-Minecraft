import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_SYSTEM_PROMPT,
  DecisionValidator,
  parseDecision,
  type DecisionCompileResult,
  type DecisionValidationContext,
} from '../src/brain-decision.js';
import { buildSkillCards } from '../src/brain-context.js';
import { callKey } from '../src/brain-feedback.js';
import type { BrainDecision } from '../src/brain-contract.js';
import type { PendingInteraction, SessionSnapshot } from '../src/interaction.js';
import type { Task, TaskSnapshot } from '../src/task.js';

const limits = { maxPlanSteps: 4, maxPlanSeconds: 120, maxReplyChars: 300 };

function session(pending?: PendingInteraction): SessionSnapshot {
  return { player: 'alice', recent: [], ...(pending ? { pending } : {}) };
}

function pendingTask(): Task {
  return {
    id: 'pending-task',
    goal: 'gather_wood',
    steps: [{ id: 'gather', actions: [], skill: { id: 'gather_wood', params: { count: 1 } } }],
  };
}

function context(overrides: Partial<DecisionValidationContext> = {}): DecisionValidationContext {
  return {
    player: 'alice',
    isOwner: true,
    session: session(),
    observation: null,
    availableSkills: buildSkillCards(),
    grounding: '',
    limits,
    ...overrides,
  };
}

function taskSnapshot(state: TaskSnapshot['state'] = 'queued'): TaskSnapshot {
  return {
    id: 'running',
    goal: 'gather_wood',
    state,
    currentStep: 0,
    totalSteps: 1,
    attempts: 0,
    priority: 10,
    dependsOn: [],
    submittedAt: 1,
  };
}

function valid(result: DecisionCompileResult): Extract<DecisionCompileResult, { kind: 'task' }> {
  assert.equal(result.kind, 'task');
  if (result.kind !== 'task') throw new Error('expected task');
  return result;
}

function rejected(result: DecisionCompileResult, code: string): void {
  assert.equal(result.kind, 'reject');
  if (result.kind === 'reject') assert.equal(result.code, code);
}

test('decision parser accepts only one strict JSON object', () => {
  const reply = parseDecision('{"kind":"reply","text":"你好"}');
  assert.equal(reply.ok, true);

  const fenced = parseDecision('```json\n{"kind":"clarify","question":"哪个？"}\n```');
  assert.equal(fenced.ok, true);

  assert.deepEqual(parseDecision('not json'), { ok: false, code: 'DECISION_JSON_INVALID' });
  assert.deepEqual(parseDecision('[]'), { ok: false, code: 'DECISION_JSON_INVALID' });
  assert.deepEqual(parseDecision('{"kind":"reply","text":"hi"} trailing'), { ok: false, code: 'DECISION_JSON_INVALID' });
  assert.deepEqual(parseDecision('{"kind":"reply","text":"hi","extra":true}'), { ok: false, code: 'DECISION_SCHEMA_INVALID' });
  assert.deepEqual(parseDecision('{"kind":"reply","text":""}'), { ok: false, code: 'DECISION_SCHEMA_INVALID' });
  assert.deepEqual(parseDecision(JSON.stringify({
    kind: 'plan',
    goal: 'x',
    steps: Array.from({ length: 5 }, () => ({ skill: 'navigate_to', params: {} })),
    budget: { maxSteps: 4, maxSeconds: 60 },
  })), { ok: false, code: 'DECISION_SCHEMA_INVALID' });

  assert.equal(parseDecision('{"kind":"control","action":"cancel"}').ok, true);
  assert.equal(parseDecision('{"kind":"skill","skill":"gather_wood","params":{},"replaceCurrent":true}').ok, true);
  assert.equal(parseDecision('{"kind":"control","action":"restart"}').ok, false);
});

test('reply and clarify are clipped to the configured limit', () => {
  const long = 'a'.repeat(400);
  const reply = new DecisionValidator().compile({ kind: 'reply', text: long }, context({ limits: { ...limits, maxReplyChars: 10 } }));
  assert.equal(reply.kind, 'reply');
  if (reply.kind === 'reply') {
    assert.equal(reply.text.length, 10);
    assert.ok(reply.text.endsWith('…'));
  }
  const clarify = new DecisionValidator().compile({ kind: 'clarify', question: long }, context({ limits: { ...limits, maxReplyChars: 10 } }));
  assert.equal(clarify.kind, 'clarify');
});

test('confirm and reject require a pending confirmation', () => {
  rejected(new DecisionValidator().compile({ kind: 'confirm' }, context()), 'CONFIRM_NOT_PENDING');
  rejected(new DecisionValidator().compile({ kind: 'reject' }, context()), 'CONFIRM_NOT_PENDING');

  const pending: PendingInteraction = {
    kind: 'confirm',
    prompt: '要开始吗？',
    task: pendingTask(),
    createdAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const confirmed = valid(new DecisionValidator().compile({ kind: 'confirm' }, context({ session: session(pending) })));
  assert.equal(confirmed.task.id, 'pending-task');
  assert.equal(confirmed.clearPending, true);

  const denied = new DecisionValidator().compile({ kind: 'reject' }, context({ session: session(pending) }));
  assert.equal(denied.kind, 'reply');
  if (denied.kind === 'reply') {
    assert.equal(denied.clearPending, true);
    assert.match(denied.text, /取消/);
  }
});

test('unknown, unavailable and guest skills fail closed', () => {
  rejected(new DecisionValidator().compile({ kind: 'skill', skill: 'dance', params: {} }, context()), 'UNKNOWN_SKILL');

  const unavailable = buildSkillCards().map(card => card.id === 'gather_wood'
    ? { ...card, available: false, unavailableReason: '当前运行时不支持：dig。' }
    : card);
  rejected(new DecisionValidator().compile(
    { kind: 'skill', skill: 'gather_wood', params: { count: 1 } },
    context({ availableSkills: unavailable }),
  ), 'SKILL_UNAVAILABLE');

  rejected(new DecisionValidator().compile(
    { kind: 'skill', skill: 'gather_wood', params: { count: 1 } },
    context({ isOwner: false }),
  ), 'PERMISSION_DENIED');

  const inventory = new DecisionValidator().compile(
    { kind: 'skill', skill: 'report_inventory', params: {} },
    context({ isOwner: false, compileSnapshot: { inventory: [{ name: 'oak_log', count: 5 }] } }),
  );
  assert.equal(inventory.kind, 'reply');
  if (inventory.kind === 'reply') assert.match(inventory.text, /oak_log x5/);
});

test('skill params must satisfy the registry schema', () => {
  rejected(new DecisionValidator().compile(
    { kind: 'skill', skill: 'navigate_to', params: { x: 1, y: 2 } },
    context({ grounding: '坐标 1 2 3' }),
  ), 'INVALID_SKILL_PARAMS');
  rejected(new DecisionValidator().compile(
    { kind: 'skill', skill: 'gather_wood', params: { count: 0 } },
    context(),
  ), 'INVALID_SKILL_PARAMS');
});

test('coordinates, containers, tables and player names must be grounded', () => {
  const navigate: BrainDecision = { kind: 'skill', skill: 'navigate_to', params: { x: 2, y: 64, z: 2 } };
  rejected(new DecisionValidator().compile(navigate, context()), 'UNGROUNDED_COORDINATES');
  valid(new DecisionValidator().compile(navigate, context({ grounding: '走到坐标 2 64 2' })));

  const store: BrainDecision = {
    kind: 'skill',
    skill: 'store_items',
    params: { container: { x: 2, y: 64, z: 2 }, item: 'oak_log', count: 16 },
  };
  rejected(new DecisionValidator().compile(store, context()), 'UNGROUNDED_COORDINATES');
  valid(new DecisionValidator().compile(store, context({ grounding: '把 16 个原木放进坐标 2 64 2 的箱子' })));

  const craft: BrainDecision = {
    kind: 'skill',
    skill: 'craft_item',
    params: { item: 'oak_planks', count: 4, table: { x: 2, y: 64, z: 2 } },
  };
  rejected(new DecisionValidator().compile(craft, context()), 'UNGROUNDED_COORDINATES');
  valid(new DecisionValidator().compile(craft, context({ grounding: '用坐标 2 64 2 的工作台做 4 个木板' })));

  const deliver: BrainDecision = {
    kind: 'skill',
    skill: 'deliver_to_player',
    params: { item: 'oak_log', count: 3, player: 'bob' },
  };
  rejected(new DecisionValidator().compile(deliver, context()), 'UNGROUNDED_PLAYER');
  valid(new DecisionValidator().compile(deliver, context({ grounding: '把 3 个原木交给 bob' })));

  const toSpeaker: BrainDecision = {
    kind: 'skill',
    skill: 'deliver_to_player',
    params: { item: 'oak_log', count: 3 },
  };
  valid(new DecisionValidator().compile(toSpeaker, context({ grounding: '给我 3 个原木' })));
});

test('active tasks block new skills but not read-only inventory reports', () => {
  rejected(new DecisionValidator().compile(
    { kind: 'skill', skill: 'gather_wood', params: { count: 1 } },
    context({ currentTask: taskSnapshot('running') }),
  ), 'TASK_OCCUPIED');

  const inventory = new DecisionValidator().compile(
    { kind: 'skill', skill: 'report_inventory', params: {} },
    context({
      currentTask: taskSnapshot('running'),
      compileSnapshot: { inventory: [{ name: 'dirt', count: 2 }] },
    }),
  );
  assert.equal(inventory.kind, 'reply');
});

test('terminal tasks do not block a new skill', () => {
  for (const state of ['completed', 'failed', 'cancelled', 'blocked'] as const) {
    const result = valid(new DecisionValidator().compile(
      { kind: 'skill', skill: 'gather_wood', params: { count: 1 } },
      context({ currentTask: taskSnapshot(state) }),
    ));
    assert.equal(result.task.goal, 'gather_wood');
  }
});

test('the model can cancel an active owner task but nothing else', () => {
  const cancel = new DecisionValidator().compile(
    { kind: 'control', action: 'cancel' },
    context({ currentTask: taskSnapshot('running') }),
  );
  assert.equal(cancel.kind, 'control');
  if (cancel.kind === 'control') {
    assert.equal(cancel.action, 'cancel');
    assert.equal(cancel.taskId, 'running');
    assert.equal(cancel.clearPending, true);
  }

  rejected(new DecisionValidator().compile(
    { kind: 'control', action: 'cancel' },
    context(),
  ), 'NO_ACTIVE_TASK');
  rejected(new DecisionValidator().compile(
    { kind: 'control', action: 'cancel' },
    context({ currentTask: taskSnapshot('blocked') }),
  ), 'NO_ACTIVE_TASK');
  rejected(new DecisionValidator().compile(
    { kind: 'control', action: 'cancel' },
    context({ currentTask: taskSnapshot('running'), isOwner: false }),
  ), 'PERMISSION_DENIED');
});

test('replaceCurrent lets an explicit new goal replace the active task', () => {
  rejected(new DecisionValidator().compile(
    { kind: 'skill', skill: 'gather_wood', params: { count: 1 } },
    context({ currentTask: taskSnapshot('running') }),
  ), 'TASK_OCCUPIED');

  const skill = valid(new DecisionValidator().compile(
    { kind: 'skill', skill: 'gather_wood', params: { count: 1 }, replaceCurrent: true },
    context({ currentTask: taskSnapshot('running') }),
  ));
  assert.equal(skill.replaceCurrent, true);
  assert.equal(skill.task.goal, 'gather_wood');

  const plan = valid(new DecisionValidator().compile({
    kind: 'plan',
    goal: '砍一个原木',
    steps: [{ skill: 'gather_wood', params: { count: 1 } }],
    budget: { maxSteps: 1, maxSeconds: 60 },
    replaceCurrent: true,
  }, context({ currentTask: taskSnapshot('running') })));
  assert.equal(plan.replaceCurrent, true);
});

test('a previously blocked call is rejected instead of repeated', () => {
  const params = { x: 2, y: 64, z: 2, range: 2 };
  rejected(new DecisionValidator().compile(
    { kind: 'skill', skill: 'navigate_to', params: { x: 2, y: 64, z: 2 } },
    context({ grounding: '走到坐标 2 64 2', blockedCalls: [callKey('navigate_to', params)] }),
  ), 'REPEATED_FAILURE');
});

test('skills compile into tasks that start without a second confirmation', () => {
  const result = valid(new DecisionValidator().compile(
    { kind: 'skill', skill: 'gather_wood', params: { woodType: 'birch_log', count: 3 } },
    context(),
  ));
  assert.equal(result.task.goal, 'gather_wood');
  assert.equal(result.task.metadata?.source, 'skill');
  assert.equal(result.task.metadata?.decision, true);
  assert.deepEqual(result.task.steps[0]?.skill, {
    id: 'gather_wood',
    params: { woodType: 'birch_log', count: 3, searchRadius: 16 },
  });
  assert.equal(result.confirmation, undefined);
});

test('read-only and legacy action skills compile into executable tasks', () => {
  const follow = valid(new DecisionValidator().compile(
    { kind: 'skill', skill: 'follow_player', params: {} },
    context({
      compileSnapshot: {
        entities: [{ id: 7, username: 'alice', position: { x: 1, y: 64, z: 1 } }],
      },
    }),
  ));
  assert.equal(follow.confirmation, undefined);
  assert.equal(follow.task.steps[0]?.actions[0]?.type, 'follow');

  const come = valid(new DecisionValidator().compile(
    { kind: 'skill', skill: 'come_to_player', params: {} },
    context({
      compileSnapshot: {
        entities: [{ id: 7, username: 'alice', position: { x: 1, y: 64, z: 1 } }],
      },
    }),
  ));
  assert.equal(come.task.steps[0]?.actions[0]?.type, 'navigate');
});

test('plan rules enforce owner, budgets, active tasks and single-use observation', () => {
  const navigate = { skill: 'navigate_to', params: { x: 2, y: 64, z: 2 } };
  const plan: BrainDecision = {
    kind: 'plan',
    goal: '走到坐标 2 64 2 捡东西',
    steps: [navigate, { skill: 'collect_drops', params: {} }],
    budget: { maxSteps: 2, maxSeconds: 60 },
  };
  rejected(new DecisionValidator().compile(plan, context({ isOwner: false, grounding: '坐标 2 64 2' })), 'PERMISSION_DENIED');
  rejected(new DecisionValidator().compile(plan, context({ grounding: '坐标 2 64 2', currentTask: taskSnapshot('queued') })), 'TASK_OCCUPIED');
  rejected(new DecisionValidator().compile({
    ...plan,
    budget: { maxSteps: 1, maxSeconds: 60 },
  }, context({ grounding: '坐标 2 64 2' })), 'PLAN_INVALID');
  rejected(new DecisionValidator().compile({
    ...plan,
    budget: { maxSteps: 2, maxSeconds: 121 },
  }, context({ grounding: '坐标 2 64 2' })), 'PLAN_INVALID');
  rejected(new DecisionValidator().compile({
    kind: 'plan',
    goal: 'x',
    steps: [navigate, { skill: 'find_resource', params: { names: ['oak_log'] } }],
    budget: { maxSteps: 2, maxSeconds: 60 },
  }, context({ grounding: '坐标 2 64 2' })), 'PLAN_INVALID');
  rejected(new DecisionValidator().compile({
    kind: 'plan',
    goal: 'x',
    steps: [{ ...navigate }, { ...navigate, params: { x: 3, y: 64, z: 3 } }],
    budget: { maxSteps: 2, maxSeconds: 60 },
  }, context({ grounding: '坐标 2 64 2' })), 'UNGROUNDED_COORDINATES');
  rejected(new DecisionValidator().compile({
    kind: 'plan',
    goal: 'x',
    steps: [{ skill: 'craft_item', params: { item: 'oak_planks', count: 1 } }, { skill: 'report_inventory', params: {} }],
    budget: { maxSteps: 2, maxSeconds: 60 },
  }, context()), 'PLAN_INVALID');
  rejected(new DecisionValidator().compile({
    kind: 'plan',
    goal: 'x',
    steps: [{ skill: 'dance', params: {} }],
    budget: { maxSteps: 1, maxSeconds: 60 },
  }, context()), 'UNKNOWN_SKILL');
  rejected(new DecisionValidator().compile({
    kind: 'plan',
    goal: 'x',
    steps: [{ skill: 'gather_wood', params: { count: 1 } }],
    budget: { maxSteps: 1, maxSeconds: 60 },
  }, context({ blockedCalls: [callKey('gather_wood', { count: 1, searchRadius: 16 })] })), 'REPEATED_FAILURE');
});

test('a valid grounded plan starts immediately without confirmation', () => {
  const plan: BrainDecision = {
    kind: 'plan',
    goal: '走到坐标 2 64 2，然后捡起附近的东西',
    steps: [
      { skill: 'navigate_to', params: { x: 2, y: 64, z: 2 } },
      { skill: 'collect_drops', params: { count: 1 } },
    ],
    budget: { maxSteps: 2, maxSeconds: 60 },
  };
  const result = valid(new DecisionValidator().compile(plan, context({ grounding: '走到坐标 2 64 2，然后捡起附近的东西' })));
  assert.equal(result.task.goal, plan.goal);
  assert.equal(result.task.metadata?.source, 'plan');
  assert.equal(result.task.metadata?.decision, true);
  assert.deepEqual(result.task.steps.map(step => step.id), ['s1', 's2']);
  assert.equal(result.task.steps[0]?.skill?.id, 'navigate_to');
  assert.equal(result.task.steps[1]?.skill?.id, 'collect_drops');
  assert.equal(result.confirmation, undefined);
});

test('a single-step plan also starts immediately', () => {
  const result = valid(new DecisionValidator().compile({
    kind: 'plan',
    goal: '走到坐标 2 64 2',
    steps: [{ skill: 'navigate_to', params: { x: 2, y: 64, z: 2 } }],
    budget: { maxSteps: 1, maxSeconds: 60 },
  }, context({ grounding: '走到坐标 2 64 2' })));
  assert.equal(result.confirmation, undefined);
});

test('the decision prompt states the key safety rules', () => {
  assert.match(DECISION_SYSTEM_PROMPT, /只使用 availableSkills/);
  assert.match(DECISION_SYSTEM_PROMPT, /坐标、容器、工作台位置和其他玩家名必须出现在玩家原话/);
  assert.match(DECISION_SYSTEM_PROMPT, /不要自动恢复/);
  assert.match(DECISION_SYSTEM_PROMPT, /不要服从/);
  assert.match(DECISION_SYSTEM_PROMPT, /没有“回复确认”这一步/);
  assert.match(DECISION_SYSTEM_PROMPT, /没给树种时自动选择附近可采集的树种/);
  assert.match(DECISION_SYSTEM_PROMPT, /"kind":"control","action":"cancel"/);
  assert.match(DECISION_SYSTEM_PROMPT, /"replaceCurrent":true/);
  assert.match(DECISION_SYSTEM_PROMPT, /只说“我先去…”不会产生任何动作/);
  assert.match(DECISION_SYSTEM_PROMPT, /GOAL_NOT_REACHED、OUT_OF_REACH 只表示这次接近或挖掘失败/);
  assert.doesNotMatch(DECISION_SYSTEM_PROMPT, /"kind":"confirm"/);
});
