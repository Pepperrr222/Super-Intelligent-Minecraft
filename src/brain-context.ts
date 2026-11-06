import { z } from 'zod';
import { DEFAULT_SKILLS } from './builtin-skills.js';
import { skills } from './skills.js';
import { availableOperations, operationCatalog } from './basic-operations.js';
import type {
  BrainContextV1,
  ObservationSummaryV1,
  RunFeedbackV1,
  SkillCardV1,
} from './brain-contract.js';
import type { PlayerMessage, SessionSnapshot } from './interaction.js';
import type { TaskSnapshot } from './task.js';

export const DEFAULT_BRAIN_LIMITS = {
  maxRecent: 8,
  maxRecentChars: 1200,
  maxInventoryItems: 64,
  maxEntities: 16,
  maxPlanSteps: 4,
  maxPlanSeconds: 120,
  maxReplyChars: 300,
  maxContextBytes: 12 * 1024,
} as const;

export type BrainContextOptions = {
  maxRecent?: number;
  maxRecentChars?: number;
  maxInventoryItems?: number;
  maxEntities?: number;
  maxPlanSteps?: number;
  maxPlanSeconds?: number;
  maxReplyChars?: number;
  maxContextBytes?: number;
  /** Minecraft version used for skill availability. */
  version?: string;
  /** Capabilities this runtime can actually perform. Omit to treat all as available. */
  capabilities?: readonly string[];
};

export type BrainContextSeed = {
  trigger: 'player_message' | 'run_finished';
  player: { name: string; isOwner: boolean };
  message?: PlayerMessage;
  session: SessionSnapshot;
  currentTask?: TaskSnapshot;
  lastRun?: RunFeedbackV1;
  /** Raw snapshot from the observation port. It is reduced immediately. */
  snapshot?: unknown;
  now?: number;
};

const SKILL_NOTES: Record<string, string[]> = {
  gather_wood: [
    '只搜索客户端已加载区块，看不到不代表不存在',
    '必须有对应树叶邻近才算候选',
    '不识别建筑、领地或保护区域',
    '未指定树种时自动选择候选最多的一种受支持原木，不需要追问树种',
  ],
  find_resource: ['只返回候选，不选目标，不保证可达', '不搜索未加载区块'],
  collect_drops: [
    '1.21.1 的实体观察不提供掉落物身份',
    'item 和 count 只用于背包增量验收，不能保证接近的就是目标物品',
  ],
  craft_item: [
    '可指定知识查询返回的 recipeRef；未指定时兼容使用 recipes[0]',
    '不递归制作中间产物',
    'table 坐标必须有依据',
  ],
  store_items: ['同时核对背包减少和容器增加', '容器坐标必须有依据'],
  deliver_to_player: ['只能确认物品离开机器人背包，不能确认对方拾取'],
  navigate_to: ['坐标必须来自玩家原话或已确认目标'],
  follow_player: ['有持续时间，默认 30 秒；不会永久跟随'],
  come_to_player: ['目标是当前请求玩家，不需要坐标'],
  report_inventory: ['只读当前背包'],
};

type JsonRecord = Record<string, unknown>;
type RawPoint = { x?: unknown; y?: unknown; z?: unknown };
type RawEntity = { username?: unknown; name?: unknown; type?: unknown; position?: RawPoint };
type RawSnapshot = {
  position?: RawPoint | null;
  health?: unknown;
  food?: unknown;
  version?: unknown;
  dimension?: unknown;
  gameMode?: unknown;
  perceptionRadius?: unknown;
  inventory?: unknown;
  equipment?: unknown;
  entities?: unknown;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function point(value: unknown): { x: number; y: number; z: number } | null {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const z = finiteNumber(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function entityKind(entity: RawEntity): 'player' | 'item' | 'mob' | 'other' {
  if (typeof entity.username === 'string' && entity.username.trim()) return 'player';
  if (entity.type === 'player') return 'player';
  if (entity.name === 'item') return 'item';
  if (entity.type === 'mob' || entity.type === 'animal' || entity.type === 'hostile' || entity.type === 'passive') {
    return 'mob';
  }
  return 'other';
}

const EQUIPMENT_SLOTS: Record<number, ObservationSummaryV1['equipped'][number]['slot']> = {
  5: 'head',
  6: 'chest',
  7: 'legs',
  8: 'feet',
  45: 'offhand',
};

/**
 * Reduce a raw client snapshot to world facts safe for the model: no slots,
 * fingerprints, NBT, custom names, entity ids or entity coordinates.
 */
export function summarizeObservation(
  raw: unknown,
  options: BrainContextOptions = {},
  now = Date.now(),
): ObservationSummaryV1 | null {
  if (!isRecord(raw)) return null;
  const snapshot = raw as RawSnapshot;
  const maxInventoryItems = options.maxInventoryItems ?? DEFAULT_BRAIN_LIMITS.maxInventoryItems;
  const maxEntities = options.maxEntities ?? DEFAULT_BRAIN_LIMITS.maxEntities;
  const position = point(snapshot.position);

  const counts = new Map<string, number>();
  for (const entry of Array.isArray(snapshot.inventory) ? snapshot.inventory : []) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : undefined;
    const count = finiteNumber(entry.count);
    if (!name || count === null || count <= 0) continue;
    counts.set(name, (counts.get(name) ?? 0) + count);
  }
  const allInventory = [...counts].sort(([a], [b]) => a.localeCompare(b));
  const inventory = allInventory.slice(0, maxInventoryItems).map(([name, count]) => ({ name, count }));

  const equipped: ObservationSummaryV1['equipped'] = [];
  const held = (raw as { heldItem?: { name?: string } }).heldItem;
  if (typeof held?.name === 'string') equipped.push({ slot: 'mainhand', name: held.name });
  for (const entry of Array.isArray(snapshot.equipment) ? snapshot.equipment : []) {
    if (!isRecord(entry)) continue;
    const slot = typeof entry.slot === 'number' ? EQUIPMENT_SLOTS[entry.slot] : undefined;
    const item = isRecord(entry.item) ? entry.item : undefined;
    const name = item && typeof item.name === 'string' ? item.name : undefined;
    if (slot && name) equipped.push({ slot, name });
  }
  equipped.sort((a, b) => a.slot.localeCompare(b.slot));

  const observedEntities: ObservationSummaryV1['entities'] = [];
  for (const entry of Array.isArray(snapshot.entities) ? snapshot.entities : []) {
    if (!isRecord(entry)) continue;
    const entity = entry as RawEntity;
    const name = text(entity.username ?? entity.name ?? entity.type, 'unknown');
    const entityPosition = point(entity.position);
    const distance = position && entityPosition
      ? Math.round(Math.hypot(
        entityPosition.x - position.x,
        entityPosition.y - position.y,
        entityPosition.z - position.z,
      ) * 10) / 10
      : null;
    observedEntities.push({ kind: entityKind(entity), name: clip(name, 64), distance });
  }
  observedEntities.sort((a, b) => {
    const da = a.distance ?? Number.POSITIVE_INFINITY;
    const db = b.distance ?? Number.POSITIVE_INFINITY;
    return da - db || a.name.localeCompare(b.name);
  });
  const entities = observedEntities.slice(0, maxEntities);

  return {
    observedAt: now,
    version: text(snapshot.version, options.version ?? 'unknown'),
    dimension: text(snapshot.dimension, 'unknown'),
    gameMode: text(snapshot.gameMode, 'unknown'),
    self: {
      position,
      health: finiteNumber(snapshot.health),
      food: finiteNumber(snapshot.food),
    },
    perception: {
      radius: finiteNumber(snapshot.perceptionRadius) ?? 16,
      scope: 'loaded_client_chunks',
      completeWorldSearch: false,
    },
    inventory,
    inventoryTruncated: allInventory.length > inventory.length,
    equipped,
    entities,
    entitiesTruncated: observedEntities.length > entities.length,
  };
}

function normalizeJsonSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return { type: 'object', properties: {} };
  const result = { ...schema };
  delete result.$schema;
  const properties = isRecord(result.properties) ? result.properties : {};
  if (Array.isArray(result.required)) {
    result.required = result.required.filter(key => {
      if (typeof key !== 'string') return false;
      const property = properties[key];
      return !(isRecord(property) && 'default' in property);
    });
  }
  return result;
}

/** Build the model-visible skill cards from the shared catalog and registry. */
export function buildSkillCards(options: {
  version?: string;
  capabilities?: readonly string[];
} = {}): SkillCardV1[] {
  const capabilities = options.capabilities ? new Set(options.capabilities) : undefined;
  const ids = [...new Set([
    ...DEFAULT_SKILLS.list().map(definition => definition.id),
    ...skills.map(skill => skill.id),
  ])].sort();

  return ids.map(id => {
    const definition = DEFAULT_SKILLS.get(id);
    const catalog = skills.find(skill => skill.id === id);
    const schema = definition?.inputSchema ?? catalog?.params;
    let params: Record<string, unknown>;
    try {
      params = schema ? normalizeJsonSchema(z.toJSONSchema(schema as z.ZodType)) : { type: 'object', properties: {} };
    } catch {
      params = { type: 'object', properties: {} };
    }

    let unavailableReason: string | undefined;
    if (definition && options.version && options.version !== 'unknown'
      && !definition.supportedVersions.includes(options.version)) {
      unavailableReason = `需要 Minecraft ${definition.supportedVersions.join(' / ')}，当前 ${options.version}。`;
    }
    if (!unavailableReason && definition && capabilities
      && !definition.requiredCapabilities.every(capability => capabilities.has(capability))) {
      const missing = definition.requiredCapabilities.filter(capability => !capabilities.has(capability));
      unavailableReason = `当前运行时不支持：${missing.join('、')}。`;
    }

    return {
      id,
      description: clip(catalog?.description ?? definition?.description ?? id, 200),
      params,
      // Confirmation is no longer requested per task; validated decisions start
      // immediately. The field stays in the V1 card for contract compatibility.
      requiresConfirmation: false,
      idempotent: definition?.idempotent ?? catalog?.idempotent ?? false,
      available: unavailableReason === undefined,
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(SKILL_NOTES[id] ? { notes: [...SKILL_NOTES[id]] } : {}),
    };
  });
}

function currentTaskSummary(task: TaskSnapshot | undefined): BrainContextV1['currentTask'] {
  if (!task) return null;
  if (!['queued', 'running', 'paused', 'cancelling'].includes(task.state)) return null;
  return {
    id: task.id,
    goal: task.goal ?? null,
    state: task.state as NonNullable<BrainContextV1['currentTask']>['state'],
    currentStep: task.currentStep,
    totalSteps: task.totalSteps,
    attempts: task.attempts,
    lastStatus: task.lastResult?.status ?? null,
    lastErrorCode: task.lastResult?.error?.code ?? null,
  };
}

function pendingSummary(session: SessionSnapshot): BrainContextV1['session']['pending'] {
  const pending = session.pending;
  if (!pending) return null;
  if (pending.kind === 'clarify') return { kind: 'clarify', question: clip(pending.question, 300) };
  return {
    kind: 'confirm',
    prompt: clip(pending.prompt, 300),
    task: { goal: pending.task.goal ?? null, steps: pending.task.steps.length },
  };
}

function recentSummary(
  session: SessionSnapshot,
  now: number,
  maxRecent: number,
  maxChars: number,
): NonNullable<BrainContextV1['session']>['recent'] {
  const picked: NonNullable<BrainContextV1['session']>['recent'] = [];
  let used = 0;
  const source = [...session.recent].reverse();
  for (const entry of source) {
    if (picked.length >= maxRecent) break;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const message = clip(entry.text, Math.min(400, remaining));
    picked.push({
      role: entry.role,
      text: message,
      ageMs: Math.max(0, now - entry.at),
    });
    used += message.length;
  }
  return picked.reverse();
}

function compactOutput(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  // Keep complete, usable references for GUI follow-up operations. Cutting a
  // JSON string in the middle of an offerRef would make the interface unusable.
  const listKey = Array.isArray(value.offers) ? 'offers' : Array.isArray(value.contents) ? 'contents' : null;
  if (listKey) {
    const list = value[listKey] as unknown[];
    const kept: unknown[] = [];
    const result = { operation: value.operation, evidence: value.evidence, targetRef: value.targetRef,
      [listKey]: kept, limited: true };
    for (const entry of list) {
      kept.push(entry);
      if (JSON.stringify(result).length > 1200) { kept.pop(); break; }
    }
    result.limited = kept.length < list.length || value.limited === true;
    return result;
  }
  const serialized = JSON.stringify(value);
  if (serialized.length <= 500) return value;
  return { truncated: true, summary: clip(serialized, 500) };
}

/** Bound the feedback to the same limits the prompt promises. */
export function truncateRunFeedback(feedback: RunFeedbackV1): RunFeedbackV1 {
  return {
    ...feedback,
    goal: feedback.goal === null ? null : clip(feedback.goal, 300),
    steps: feedback.steps.slice(0, 12).map(step => ({
      ...step,
      output: step.output ? compactOutput(step.output) : null,
      error: step.error ? { code: clip(step.error.code, 100), message: clip(step.error.message, 300) } : null,
    })),
    verifiedChanges: {
      inventory: feedback.verifiedChanges.inventory.slice(0, 64),
      containers: feedback.verifiedChanges.containers.slice(0, 16),
      position: feedback.verifiedChanges.position,
    },
    sideEffects: feedback.sideEffects.slice(0, 12).map(effect => clip(effect, 300)),
  };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Trim low-priority fields until the serialized context fits the byte budget.
 * Skill cards are kept (the model must not invent capabilities); notes and
 * descriptions are the first things to go.
 */
function fitContext(context: BrainContextV1, maxBytes: number): BrainContextV1 {
  let fitted: BrainContextV1 = context;
  const steps: Array<() => BrainContextV1> = [
    () => ({
      ...fitted,
      availableSkills: fitted.availableSkills.map(card => {
        const next = { ...card };
        delete next.notes;
        return next;
      }),
      truncated: true,
    }),
    () => ({ ...fitted, session: { ...fitted.session, recent: fitted.session.recent.slice(-4) }, truncated: true }),
    () => ({ ...fitted, session: { ...fitted.session, recent: [] }, truncated: true }),
    () => ({
      ...fitted,
      availableSkills: fitted.availableSkills.map(card => ({
        ...card,
        description: clip(card.description, 60),
      })),
      truncated: true,
    }),
    () => {
      if (!fitted.observation) return fitted;
      const inventory = fitted.observation.inventory;
      if (inventory.length === 0) return fitted;
      return {
        ...fitted,
        observation: {
          ...fitted.observation,
          inventory: inventory.slice(0, Math.max(1, Math.floor(inventory.length / 2))),
          inventoryTruncated: true,
        },
        truncated: true,
      };
    },
    () => {
      if (!fitted.observation) return fitted;
      const entities = fitted.observation.entities;
      if (entities.length === 0) return fitted;
      return {
        ...fitted,
        observation: {
          ...fitted.observation,
          entities: entities.slice(0, Math.max(1, Math.floor(entities.length / 2))),
          entitiesTruncated: true,
        },
        truncated: true,
      };
    },
    () => {
      if (!fitted.observation) return fitted;
      return {
        ...fitted,
        observation: { ...fitted.observation, inventory: [], inventoryTruncated: true },
        truncated: true,
      };
    },
    () => {
      if (!fitted.observation) return fitted;
      return {
        ...fitted,
        observation: { ...fitted.observation, entities: [], entitiesTruncated: true },
        truncated: true,
      };
    },
    () => ({
      ...fitted,
      lastRun: fitted.lastRun
        ? { ...fitted.lastRun, steps: fitted.lastRun.steps.slice(0, 4), sideEffects: fitted.lastRun.sideEffects.slice(0, 4) }
        : null,
      truncated: true,
    }),
  ];

  for (const step of steps) {
    if (byteLength(fitted) <= maxBytes) return fitted;
    fitted = step();
  }
  return fitted;
}

/** Build the complete, bounded model request context. */
export function buildBrainContext(
  seed: BrainContextSeed,
  options: BrainContextOptions = {},
): BrainContextV1 {
  const now = seed.now ?? Date.now();
  const limits = {
    maxPlanSteps: options.maxPlanSteps ?? DEFAULT_BRAIN_LIMITS.maxPlanSteps,
    maxPlanSeconds: options.maxPlanSeconds ?? DEFAULT_BRAIN_LIMITS.maxPlanSeconds,
    maxReplyChars: options.maxReplyChars ?? DEFAULT_BRAIN_LIMITS.maxReplyChars,
  };
  const observation = summarizeObservation(seed.snapshot, options, now);
  const version = observation?.version ?? options.version;
  const context: BrainContextV1 = {
    schema: 'sim.brain.v1',
    trigger: seed.trigger,
    now,
    player: { name: seed.player.name, isOwner: seed.player.isOwner },
    ...(seed.message ? {
      message: { text: clip(seed.message.text, 2000), channel: seed.message.channel ?? 'chat' },
    } : {}),
    session: {
      recent: recentSummary(
        seed.session,
        now,
        options.maxRecent ?? DEFAULT_BRAIN_LIMITS.maxRecent,
        options.maxRecentChars ?? DEFAULT_BRAIN_LIMITS.maxRecentChars,
      ),
      pending: pendingSummary(seed.session),
      lastGoal: seed.session.lastGoal ? clip(seed.session.lastGoal, 300) : null,
    },
    currentTask: currentTaskSummary(seed.currentTask),
    lastRun: seed.lastRun ? truncateRunFeedback(seed.lastRun) : null,
    observation,
    availableSkills: buildSkillCards({
      ...(version && version !== 'unknown' ? { version } : {}),
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    }),
    limits,
    availableOperations: availableOperations(version, options.capabilities),
    operationCatalog: operationCatalog(version, options.capabilities),
  };

  return fitContext(context, options.maxContextBytes ?? DEFAULT_BRAIN_LIMITS.maxContextBytes);
}

/** Small helper for the decision prompt / tests. */
export function contextBytes(context: unknown): number {
  return Buffer.byteLength(JSON.stringify(context), 'utf8');
}

/** Re-exported helper so tests and callers can type a raw message without importing interaction. */
export type BrainContextMessage = PlayerMessage;
