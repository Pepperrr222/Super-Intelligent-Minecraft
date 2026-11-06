import type { ControllerResult, Task, TaskSnapshot } from './task.js';
import type { RunFeedbackV1 } from './brain-contract.js';

const ITEM_LABELS: Record<string, string> = {
  oak_log: '橡木原木',
  spruce_log: '云杉原木',
  birch_log: '白桦原木',
  jungle_log: '丛林原木',
  acacia_log: '金合欢原木',
  dark_oak_log: '深色橡木原木',
  mangrove_log: '红树林原木',
  cherry_log: '樱花原木',
  oak_planks: '橡木木板',
  spruce_planks: '云杉木板',
  birch_planks: '白桦木板',
  stick: '木棍',
  crafting_table: '工作台',
  dirt: '泥土',
  stone: '石头',
  cobblestone: '圆石',
  bread: '面包',
  apple: '苹果',
  coal: '煤炭',
  iron_ingot: '铁锭',
  diamond: '钻石',
};

/** Best-effort localized display name; unknown ids stay as registry names. */
export function itemLabel(name: string | null | undefined): string {
  if (!name) return '物品';
  return ITEM_LABELS[name] ?? name;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const point = (value: unknown): { x: number; y: number; z: number } | null => {
  if (!isRecord(value)) return null;
  const x = number(value.x);
  const y = number(value.y);
  const z = number(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
};

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function callKey(skill: string, params: Record<string, unknown>): string {
  return `${skill}:${stableStringify(params)}`;
}

export function failureKey(skill: string, params: Record<string, unknown>, code: string): string {
  return `${callKey(skill, params)}:${code}`;
}

export type FailureEntry = { call: string; failure: string; code: string };

/** Derive the program-side keys for repeated-failure protection. */
export function failureEntries(task: Task, feedback: RunFeedbackV1): FailureEntry[] {
  const entries: FailureEntry[] = [];
  const seen = new Set<string>();
  for (const step of feedback.steps) {
    if (step.status === 'ok' || step.status === 'not_run' || !step.error) continue;
    const taskStep = task.steps.find(candidate => candidate.id === step.stepId);
    const primitive = taskStep?.actions.find(action => action.type === 'operate');
    const invocation = taskStep?.skill ?? (primitive?.type === 'operate' ? { id: 'operate', params: primitive.operation } : undefined);
    if (!invocation) continue;
    const key = failureKey(invocation.id, invocation.params, step.error.code);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      call: callKey(invocation.id, invocation.params),
      failure: key,
      code: step.error.code,
    });
  }
  return entries;
}

export type FeedbackInput = {
  task: Task;
  snapshot: TaskSnapshot;
  startedAt?: number;
  now?: number;
};

function resultStatus(status: ControllerResult['status']): RunFeedbackV1['steps'][number]['status'] {
  switch (status) {
    case 'ok': return 'ok';
    case 'blocked': return 'blocked';
    case 'busy': return 'busy';
    case 'cancelled': return 'cancelled';
    case 'timeout': return 'timeout';
    case 'error': return 'error';
    case 'partial': return 'partial';
  }
}

function outputOf(result: ControllerResult): JsonRecord | null {
  if (!isRecord(result.data)) return null;
  if (isRecord(result.data.output)) return result.data.output;
  return result.data;
}

function effectList(result: ControllerResult): string[] {
  if (!isRecord(result.data)) return [];
  const effects = result.data.partialEffects;
  return Array.isArray(effects) ? effects.filter((effect): effect is string => typeof effect === 'string') : [];
}

function lastResults(snapshot: TaskSnapshot): ControllerResult[] {
  const results = snapshot.stepResults?.length
    ? snapshot.stepResults
    : snapshot.lastResult
      ? [snapshot.lastResult]
      : [];
  const byStep = new Map<string, ControllerResult>();
  for (const result of results) byStep.set(result.stepId, result);
  return [...byStep.values()];
}

function observableChange(
  skill: string | null,
  status: RunFeedbackV1['steps'][number]['status'],
  output: JsonRecord | null,
): boolean {
  if (status !== 'ok' || !output) return false;
  if (typeof output.operation === 'string') {
    if (output.evidence === 'inventory_delta') return operationDelta(output) !== 0;
    if (output.evidence === 'client_block_changed') return typeof output.block === 'string'
      || typeof output.before === 'string' && output.before !== output.after;
  }
  switch (skill) {
    case 'gather_wood': {
      const collected = number(output.collected);
      const requested = number(output.requested);
      return collected !== null && requested !== null && collected >= requested;
    }
    case 'collect_drops': {
      const collected = number(output.collected);
      const requested = number(output.requested);
      return collected !== null && requested !== null && collected >= requested;
    }
    case 'craft_item': {
      const crafted = number(output.crafted);
      const requested = number(output.requested);
      return crafted !== null && requested !== null && crafted >= requested;
    }
    case 'store_items': {
      const inventoryBefore = number(output.inventoryBefore);
      const inventoryAfter = number(output.inventoryAfter);
      const containerBefore = number(output.containerBefore);
      const containerAfter = number(output.containerAfter);
      return inventoryBefore !== null && inventoryAfter !== null
        && containerBefore !== null && containerAfter !== null
        && inventoryAfter < inventoryBefore
        && containerAfter > containerBefore;
    }
    case 'deliver_to_player': {
      const tossed = number(output.tossed);
      const requested = number(output.requested);
      return tossed !== null && requested !== null && tossed >= requested;
    }
    case 'navigate_to': {
      const distance = number(output.distanceAfter);
      const range = number(output.range);
      return point(output.positionAfter) !== null
        && distance !== null
        && range !== null
        && distance <= range;
    }
    case 'find_resource':
      return Array.isArray(output.blocks);
    default:
      // Action-only steps (plan entries such as follow_player / come_to_player)
      // expose raw action data. Elapsed follow time is not a world change; a
      // client-observed final position is. Unknown shapes fail closed.
      return output.evidence === 'position_observed' && point(output.position) !== null;
  }
}

/** Build the program-verified feedback for one terminal task. */
export function buildRunFeedback(input: FeedbackInput): RunFeedbackV1 {
  const now = input.now ?? Date.now();
  const results = lastResults(input.snapshot);
  const resultByStep = new Map(results.map(result => [result.stepId, result]));
  const steps: RunFeedbackV1['steps'] = input.task.steps.map(step => {
    const result = resultByStep.get(step.id);
    if (!result) {
      return {
        stepId: step.id,
        skill: step.skill?.id ?? null,
        status: 'not_run',
        evidence: null,
        error: null,
        output: null,
      };
    }
    return {
      stepId: step.id,
      skill: step.skill?.id ?? null,
      status: resultStatus(result.status),
      evidence: result.evidence ?? null,
      error: result.error ? { code: result.error.code, message: result.error.message } : null,
      output: outputOf(result),
    };
  });

  const executed = steps.filter(step => step.status !== 'not_run');
  const lastResult = input.snapshot.lastResult;
  const failedStatus = lastResult?.status;
  const anyPartial = steps.some(step => step.status === 'partial');
  const outcome: RunFeedbackV1['outcome'] = input.snapshot.state === 'completed'
    ? 'completed'
    : input.snapshot.state === 'cancelled'
      ? 'cancelled'
      : input.snapshot.state === 'blocked'
        ? 'blocked'
        : failedStatus === 'timeout'
          ? 'timeout'
          : anyPartial || failedStatus === 'partial'
            ? 'partial'
            : 'failed';

  const lastExecuted = [...executed].reverse().find(step => step.status !== 'not_run');
  const allOk = executed.length > 0 && executed.every(step => step.status === 'ok');
  const lastVerified = lastExecuted?.evidence === 'step_verified';
  const hasChange = executed.some(step => observableChange(step.skill, step.status, step.output));
  const verified = input.snapshot.state === 'completed'
    && allOk
    && lastVerified
    && hasChange;

  const inventory = new Map<string, number>();
  const containers: RunFeedbackV1['verifiedChanges']['containers'] = [];
  let position: RunFeedbackV1['verifiedChanges']['position'] = null;
  const sideEffects: string[] = [];

  for (const step of executed) {
    const output = step.output;
    if (!output) continue;
    const add = (item: unknown, delta: unknown): void => {
      if (typeof item !== 'string') return;
      const value = number(delta);
      if (value === null || value === 0) return;
      inventory.set(item, (inventory.get(item) ?? 0) + value);
    };
    if (step.skill === 'gather_wood' || step.skill === 'craft_item') {
      add(output.woodType ?? output.item, step.skill === 'gather_wood' ? output.collected : output.crafted);
    }
    if (step.skill === 'collect_drops') add(output.item, output.collected);
    if (typeof output.operation === 'string' && output.evidence === 'inventory_delta') add(output.item, operationDelta(output));
    if (step.skill === 'deliver_to_player') {
      const tossed = number(output.tossed);
      add(output.item, tossed === null ? null : -tossed);
      if (step.status === 'ok' && tossed !== null) {
        sideEffects.push(`已丢出 ${tossed} 个 ${itemLabel(typeof output.item === 'string' ? output.item : null)}；客户端无法确认对方拾取`);
      }
    }
    if (step.skill === 'store_items') {
      const inventoryBefore = number(output.inventoryBefore);
      const inventoryAfter = number(output.inventoryAfter);
      if (inventoryBefore !== null && inventoryAfter !== null) {
        add(output.item, inventoryAfter - inventoryBefore);
      }
      const containerBefore = number(output.containerBefore);
      const containerAfter = number(output.containerAfter);
      const containerPosition = point(output.container);
      if (containerPosition && typeof output.item === 'string'
        && containerBefore !== null && containerAfter !== null
        && containerAfter !== containerBefore) {
        containers.push({
          position: containerPosition,
          item: output.item,
          delta: containerAfter - containerBefore,
        });
      }
    }
    if (step.skill === 'navigate_to') {
      const before = point(output.positionBefore);
      const after = point(output.positionAfter);
      const target = point(output.target);
      position = {
        before,
        after,
        ...(target ? { target } : {}),
        ...(number(output.range) !== null ? { range: number(output.range)! } : {}),
      };
    }
    const taskStep = input.task.steps.find(candidate => candidate.id === step.stepId);
    if (taskStep) {
      for (const result of results.filter(candidate => candidate.stepId === step.stepId)) {
        sideEffects.push(...effectList(result));
      }
    }
  }

  return {
    taskId: input.snapshot.id,
    goal: input.task.goal ?? null,
    source: input.task.metadata?.source === 'plan' || input.task.steps.length > 1 ? 'plan' : 'skill',
    outcome,
    verified,
    finishedAt: now,
    elapsedMs: Math.max(0, now - (input.startedAt ?? input.snapshot.submittedAt)),
    steps,
    verifiedChanges: {
      inventory: [...inventory].filter(([, delta]) => delta !== 0).map(([item, delta]) => ({ item, delta })),
      containers,
      position,
    },
    sideEffects: [...new Set(sideEffects)].slice(0, 12),
    retryable: outcome === 'failed' || outcome === 'timeout' || outcome === 'partial',
    repeatedFailure: false,
  };
}

function errorOf(feedback: RunFeedbackV1): string | null {
  const error = [...feedback.steps].reverse().find(step => step.error)?.error;
  return error ? error.message : null;
}

function firstOutput(feedback: RunFeedbackV1): JsonRecord | null {
  return [...feedback.steps].reverse().find(step => step.output)?.output ?? null;
}

/** Deterministic player-facing result text. The model only supplements this. */
export function describeFeedback(feedback: RunFeedbackV1): string {
  const reason = errorOf(feedback);
  const output = firstOutput(feedback);
  if (feedback.outcome === 'completed' && feedback.verified) {
    const gained = feedback.verifiedChanges.inventory.filter(change => change.delta > 0);
    if (gained.length > 0) {
      const shown = gained.slice(0, 3).map(change => `${change.delta} 个 ${itemLabel(change.item)}`).join('、');
      return `完成：获得 ${shown}。`;
    }
    const lost = feedback.verifiedChanges.inventory.filter(change => change.delta < 0);
    if (lost.length > 0) {
      const shown = lost.slice(0, 3).map(change => `${-change.delta} 个 ${itemLabel(change.item)}`).join('、');
      const receipt = feedback.steps.some(step => step.skill === 'deliver_to_player');
      const stored = feedback.steps.some(step => step.skill === 'store_items');
      const verb = receipt ? '交付了' : stored ? '存入' : '失去';
      return `完成：${verb} ${shown}${receipt ? '；客户端无法确认对方是否拾取' : ''}。`;
    }
    if (feedback.verifiedChanges.position?.after) return '完成：已到达目标附近。';
    if (Array.isArray(output?.blocks)) return `完成：找到 ${output.blocks.length} 个候选方块。`;
    return '完成。';
  }
  if (feedback.outcome === 'completed') return '执行结束，但没有观测到可确认的变化。';

  if (feedback.outcome === 'partial') {
    if (output) {
      const collected = number(output.collected);
      const crafted = number(output.crafted);
      const requested = number(output.requested);
      const item = typeof output.woodType === 'string'
        ? output.woodType
        : typeof output.item === 'string' ? output.item : null;
      if (collected !== null && requested !== null) {
        return `未完成：获得 ${collected}/${requested} 个 ${itemLabel(item)}${reason ? `（${reason}）` : ''}。`;
      }
      if (crafted !== null && requested !== null) {
        return `未完成：制作了 ${crafted}/${requested} 个 ${itemLabel(item)}${reason ? `（${reason}）` : ''}。`;
      }
    }
    return `未完成：${reason ?? '结果没有达到目标'}。`;
  }
  if (feedback.outcome === 'blocked') return `没能开始：${reason ?? '条件不满足'}。`;
  if (feedback.outcome === 'timeout') return `超时：${reason ?? '没有在预算内完成'}。`;
  if (feedback.outcome === 'failed') return `失败：${reason ?? '未知原因'}。`;
  const effects = feedback.sideEffects.length > 0 ? `已发生：${feedback.sideEffects.join('；')}。` : '';
  return `已取消。${effects}`;
}

export { ITEM_LABELS };

function operationDelta(output: JsonRecord): number {
  return number(output.gained) ?? number(output.delta) ?? -(number(output.removed) ?? 0);
}
