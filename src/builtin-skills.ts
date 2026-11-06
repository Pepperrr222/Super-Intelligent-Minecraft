import { z } from 'zod';
import type { Action, ActionResult } from './schema.js';
import type { ActionPort, ControllerStatus } from './task.js';
import { recipeRefSchema } from './schema.js';
import type { RecipeRecord } from './recipes.js';
import {
  SkillRegistry,
  SkillRunError,
  SkillRunner,
  createSkillContext,
  skillStatusToController,
  type SkillContext,
  type SkillDefinition,
  type SkillEvidence,
  type SkillResult,
  type SkillRunResult,
  type SkillStatus,
} from './skill-runtime.js';

type Point = { x: number; y: number; z: number };
type InventoryEntry = { name: string; count: number };
type SnapshotEntity = {
  id: number;
  name?: string;
  type?: string;
  username?: string;
  position?: Point;
};
type Snapshot = {
  position?: Point;
  inventory?: InventoryEntry[];
  entities?: SnapshotEntity[];
  dimension?: string;
  version?: string;
};
type BlockObservation = {
  known: boolean;
  name?: string;
  position?: Point;
  diggable?: boolean;
  reason?: string;
};

const inventoryCount = (snapshot: Snapshot | undefined, item: string): number =>
  (snapshot?.inventory ?? [])
    .filter(entry => entry.name === item)
    .reduce((sum, entry) => sum + entry.count, 0);

const inventoryTotal = (snapshot: Snapshot | undefined): number =>
  (snapshot?.inventory ?? []).reduce((sum, entry) => sum + entry.count, 0);

const floorPoint = (point: Point): Point => ({
  x: Math.floor(point.x),
  y: Math.floor(point.y),
  z: Math.floor(point.z),
});

const euclidean = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Same comparison the navigate action uses: floored block position vs target. */
const blockDistance = (position: Point, target: Point): number =>
  euclidean(floorPoint(position), target);

function actionEvidence(result: SkillResult): ActionResult[] {
  return result.evidence
    .filter((item): item is Extract<SkillEvidence, { kind: 'action' }> => item.kind === 'action')
    .map(item => item.action);
}

/* -------------------------------------------------------------------------- */
/* navigate_to                                                                */
/* -------------------------------------------------------------------------- */

export const navigateToParams = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  range: z.number().min(0).max(16).default(2),
}).strict();

export type NavigateToInput = z.input<typeof navigateToParams>;
type NavigateToParams = z.output<typeof navigateToParams>;
export type NavigateToOutput = {
  target: Point;
  range: number;
  dimension?: string;
  positionBefore: Point | null;
  positionAfter: Point | null;
  distanceBefore: number | null;
  distanceAfter: number | null;
  navigated: boolean;
};

/**
 * Reach a coordinate and confirm the final position. A successful pathfinder
 * promise alone is not the success condition; the position is read again.
 */
export const navigateToSkill: SkillDefinition<NavigateToParams, NavigateToOutput> = {
  id: 'navigate_to',
  description: '导航到指定坐标附近，并复查最终位置',
  inputSchema: navigateToParams,
  supportedVersions: ['1.21.1'],
  risk: 'low',
  requiredCapabilities: ['observe', 'navigate'],
  idempotent: true,
  async run(params, ctx) {
    const target = { x: params.x, y: params.y, z: params.z };
    const before = ctx.query<Snapshot>({ type: 'snapshot', radius: 16 });
    const positionBefore = before.position ?? null;
    const distanceBefore = positionBefore ? euclidean(positionBefore, target) : null;
    const output: NavigateToOutput = {
      target,
      range: params.range,
      ...(before.dimension ? { dimension: before.dimension } : {}),
      positionBefore,
      positionAfter: null,
      distanceBefore,
      distanceAfter: null,
      navigated: false,
    };
    if (!positionBefore) {
      return {
        status: 'blocked',
        output,
        error: { code: 'POSITION_UNOBSERVED', message: '无法读取当前位置' },
      };
    }

    const alreadyThere = blockDistance(positionBefore, target) <= params.range;
    ctx.report(
      alreadyThere
        ? `已在目标 (${target.x}, ${target.y}, ${target.z}) 附近`
        : `开始前往 (${target.x}, ${target.y}, ${target.z})`,
      { distance: distanceBefore, range: params.range },
    );

    if (!alreadyThere) {
      await ctx.execute({ type: 'navigate', position: target, range: params.range });
    }

    const after = ctx.query<Snapshot>({ type: 'snapshot', radius: 16 });
    const positionAfter = after.position ?? null;
    const distanceAfter = positionAfter ? euclidean(positionAfter, target) : null;
    output.positionAfter = positionAfter;
    output.distanceAfter = distanceAfter;
    output.navigated = !alreadyThere;

    if (!positionAfter) {
      return {
        status: 'partial',
        output,
        error: { code: 'POSITION_UNOBSERVED', message: '导航结束，但没有读到最终位置' },
      };
    }
    if (blockDistance(positionAfter, target) > params.range) {
      return {
        status: 'partial',
        output,
        error: { code: 'DESTINATION_NOT_CONFIRMED', message: '导航结束，但最终位置不在目标范围内' },
      };
    }

    ctx.report(`已到达目标附近，距离 ${distanceAfter?.toFixed(2) ?? '未知'}`, {
      distance: distanceAfter,
    });
    return { status: 'succeeded', output };
  },
};

/* -------------------------------------------------------------------------- */
/* collect_drops                                                              */
/* -------------------------------------------------------------------------- */

export const collectDropsParams = z.object({
  item: z.string().min(1).max(100).optional(),
  count: z.number().int().min(1).max(2304).default(1),
  radius: z.number().int().min(1).max(16).default(8),
  maxDrops: z.number().int().min(1).max(16).default(6),
  waitMs: z.number().int().min(100).max(5000).default(600),
}).strict();

export type CollectDropsInput = z.input<typeof collectDropsParams>;
type CollectDropsParams = z.output<typeof collectDropsParams>;
export type CollectDropsOutput = {
  item?: string;
  requested: number;
  collected: number;
  approached: number;
  unreachable: number;
  observedDrops: number;
  remainingDrops: number;
  scope: 'loaded_client_chunks';
};

type CollectDropsOptions = CollectDropsParams & { initialWaitMs?: number };

/**
 * Shared by collect_drops and gather_wood. It approaches observed item entities
 * one at a time and judges pickup by inventory delta, not by the wait action.
 * Individual unreachable drops do not abort the whole collection.
 */
async function collectNearbyDrops(
  ctx: SkillContext,
  options: CollectDropsOptions,
): Promise<SkillRunResult<CollectDropsOutput>> {
  const read = () => ctx.query<Snapshot>({ type: 'snapshot', radius: 16 });
  const amount = (snapshot: Snapshot): number =>
    options.item ? inventoryCount(snapshot, options.item) : inventoryTotal(snapshot);
  const dropsIn = (snapshot: Snapshot): SnapshotEntity[] => {
    const origin = snapshot.position;
    if (!origin) return [];
    return (snapshot.entities ?? [])
      .filter(entity => entity.name === 'item' && entity.position)
      .filter(entity => euclidean(origin, entity.position!) <= options.radius)
      .sort((a, b) => euclidean(origin, a.position!) - euclidean(origin, b.position!));
  };
  const output = (
    collected: number,
    approached: number,
    unreachable: number,
    remainingDrops: number,
    observedDrops: number,
  ): CollectDropsOutput => ({
    ...(options.item ? { item: options.item } : {}),
    requested: options.count,
    collected,
    approached,
    unreachable,
    observedDrops,
    remainingDrops,
    scope: 'loaded_client_chunks',
  });

  let snapshot = read();
  const baseline = amount(snapshot);
  let drops = dropsIn(snapshot);
  if (drops.length === 0 && options.initialWaitMs) {
    await ctx.execute({ type: 'wait', durationMs: options.initialWaitMs });
    snapshot = read();
    drops = dropsIn(snapshot);
  }
  const observedDrops = drops.length;
  if (observedDrops === 0) {
    return {
      status: 'blocked',
      output: output(0, 0, 0, 0, 0),
      error: { code: 'NO_DROPS_OBSERVED', message: '附近没有观测到可拾取的掉落物' },
    };
  }

  ctx.report(`观察到 ${observedDrops} 个掉落物`, { observedDrops });
  const attempts = new Map<number, number>();
  const maxAttemptsPerDrop = 2;
  let approached = 0;
  let unreachable = 0;
  // maxDrops is the number of distinct drops; allow a small retry budget for
  // drops that were still falling when first approached.
  const attemptLimit = options.maxDrops + 2;

  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    ctx.check();
    snapshot = read();
    const current = amount(snapshot);
    if (current - baseline >= options.count) {
      const collected = Math.max(0, current - baseline);
      const remainingDrops = dropsIn(snapshot).length;
      ctx.report(`已拾取 ${collected}/${options.count}`, { collected, remainingDrops });
      return { status: 'succeeded', output: output(collected, approached, unreachable, remainingDrops, observedDrops) };
    }

    const origin = snapshot.position;
    const candidates = dropsIn(snapshot)
      .filter(entity => (attempts.get(entity.id) ?? 0) < maxAttemptsPerDrop);
    candidates.sort((a, b) => (attempts.get(a.id) ?? 0) - (attempts.get(b.id) ?? 0)
      || (origin ? euclidean(origin, a.position!) - euclidean(origin, b.position!) : 0));
    const candidate = candidates[0];
    if (!candidate?.position) break;
    attempts.set(candidate.id, (attempts.get(candidate.id) ?? 0) + 1);

    try {
      await ctx.execute({
        type: 'navigate',
        position: floorPoint(candidate.position),
        range: 1,
      });
    } catch (error) {
      if (error instanceof SkillRunError && (error.code === 'CANCELLED' || error.code === 'DEADLINE_EXCEEDED')) throw error;
      unreachable++;
      ctx.report('无法接近掉落物，等待后重试', {
        entityId: candidate.id,
        code: error instanceof SkillRunError ? error.code : 'UNREACHABLE',
      });
      // A freshly broken block drops an item in the air; let it land so the
      // retry uses an updated position instead of an unreachable air block.
      await ctx.execute({ type: 'wait', durationMs: 250 });
      continue;
    }

    await ctx.execute({ type: 'wait', durationMs: options.waitMs });
    approached++;
    const after = read();
    const collected = Math.max(0, amount(after) - baseline);
    ctx.report(`拾取进度 ${collected}/${options.count}`, { collected, approached });
  }

  const final = read();
  const collected = Math.max(0, amount(final) - baseline);
  const remainingDrops = dropsIn(final).length;
  if (collected >= options.count) {
    return { status: 'succeeded', output: output(collected, approached, unreachable, remainingDrops, observedDrops) };
  }
  return {
    status: 'partial',
    output: output(collected, approached, unreachable, remainingDrops, observedDrops),
    error: { code: 'PICKUP_UNCONFIRMED', message: '接近了掉落物，但没有观测到足够的背包增量' },
  };
}

export const collectDropsSkill: SkillDefinition<CollectDropsParams, CollectDropsOutput> = {
  id: 'collect_drops',
  description: '接近附近的掉落物，并按背包增量验证拾取',
  inputSchema: collectDropsParams,
  supportedVersions: ['1.21.1'],
  risk: 'low',
  requiredCapabilities: ['observe', 'navigate'],
  idempotent: false,
  async run(params, ctx) {
    return collectNearbyDrops(ctx, params);
  },
};

/* -------------------------------------------------------------------------- */
/* gather_wood                                                                */
/* -------------------------------------------------------------------------- */

const WOOD_TYPES = [
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
] as const;

const gatherWoodParams = z.object({
  woodType: z.enum(WOOD_TYPES).optional(),
  count: z.number().int().min(1).max(64).default(1),
  searchRadius: z.number().int().min(1).max(16).default(16),
}).strict();

export type GatherWoodInput = z.input<typeof gatherWoodParams>;
type GatherWoodParams = z.output<typeof gatherWoodParams>;
export type GatherWoodOutput = { requested: number; collected: number; woodType: string | null };

const leavesFor = (woodType: string): string => woodType.replace(/_log$/u, '_leaves');
const canopyNear = (log: Point, leaf: Point): boolean => {
  const dx = Math.abs(leaf.x - log.x);
  const dz = Math.abs(leaf.z - log.z);
  const dy = leaf.y - log.y;
  return dx <= 3 && dz <= 3 && dy >= 1 && dy <= 6;
};

/**
 * `find_blocks` returns the nearest `limit` blocks **matching any name**.
 * Querying logs and leaves together therefore lets a large canopy consume
 * the whole budget and hide most of the trunk. Logs and leaves are read
 * separately so every nearby trunk block remains visible.
 */
function observedBlocks(
  ctx: SkillContext,
  names: string[],
  radius: number,
  limit: number,
): BlockObservation[] {
  const found = ctx.query<{ blocks: BlockObservation[] }>({
    type: 'find_blocks',
    names,
    radius,
    limit,
  });
  const wanted = new Set(names);
  return (found.blocks ?? []).filter(block =>
    block.known && block.position && typeof block.name === 'string' && wanted.has(block.name));
}

/** Both columns of a 2x2 trunk are within this horizontal footprint. */
type TreeFootprint = { x: number; z: number };

const withinTree = (position: Point, tree: TreeFootprint): boolean =>
  Math.abs(position.x - tree.x) <= 2 && Math.abs(position.z - tree.z) <= 2;

/**
 * Logs of one species that have a matching canopy above them. Sorted by
 * distance so the closest eligible tree is tried first.
 */
function eligibleLogs(
  blocks: BlockObservation[],
  type: string,
  origin: Point | undefined,
): Array<{ block: BlockObservation; distance: number }> {
  const leaves = blocks.filter(block => block.known && block.name === leavesFor(type) && block.position);
  return blocks
    .filter(block => block.known
      && block.name === type
      && block.position
      && leaves.some(leaf => leaf.position && canopyNear(block.position!, leaf.position)))
    .map(block => ({ block, distance: origin ? euclidean(origin, block.position!) : 0 }))
    .sort((a, b) => a.distance - b.distance);
}

/**
 * First complete vertical slice of the skill library. It observes before and
 * after every action, rechecks the target, and reports success only when the
 * requested log increment is actually present in the inventory.
 */
export const gatherWoodSkill: SkillDefinition<GatherWoodParams, GatherWoodOutput> = {
  id: 'gather_wood',
  description: '采集附近原木；未指定树种时自动选择附近可采集的树种，并验证背包增量',
  inputSchema: gatherWoodParams,
  outputSchema: z.object({
    requested: z.number().int(),
    collected: z.number().int(),
    woodType: z.string().nullable(),
  }).strict(),
  supportedVersions: ['1.21.1'],
  risk: 'requires_confirmation',
  requiredCapabilities: ['observe', 'navigate', 'dig'],
  idempotent: false,
  async run(params, ctx) {
    let woodType: string | null = params.woodType ?? null;
    let baseline: number | undefined;
    let collected = 0;
    const result = (status: SkillStatus, code?: string, message?: string): SkillRunResult<GatherWoodOutput> => ({
      status,
      output: { requested: params.count, collected, woodType },
      ...(code ? { error: { code, message: message ?? code } } : {}),
      partialEffects: collected > 0 && woodType ? [`已采集并拾取 ${collected} 个 ${woodType}`] : [],
    });
    const snapshot = (): Snapshot => {
      const value = ctx.query<Snapshot>({ type: 'snapshot', radius: params.searchRadius });
      if (!Array.isArray(value?.inventory)) {
        throw new SkillRunError('INVENTORY_UNKNOWN', '无法读取背包');
      }
      return value;
    };

    try {
      ctx.check();
      const initial = snapshot();
      if (!woodType) {
        // Read each species' logs and leaves separately: a large canopy or a
        // mixed forest must not consume a shared nearest-block budget and hide
        // the upper trunk.
        let best: { type: string; count: number; nearest: number } | undefined;
        for (const type of WOOD_TYPES) {
          const typeLogs = observedBlocks(ctx, [type], params.searchRadius, 128);
          if (typeLogs.length === 0) continue;
          const typeLeaves = observedBlocks(ctx, [leavesFor(type)], params.searchRadius, 128);
          const eligible = eligibleLogs([...typeLogs, ...typeLeaves], type, initial.position);
          if (eligible.length === 0) continue;
          const candidate = { type, count: eligible.length, nearest: eligible[0]!.distance };
          if (!best || candidate.count > best.count
            || (candidate.count === best.count && candidate.nearest < best.nearest)) {
            best = candidate;
          }
        }
        if (!best) {
          return result('blocked', 'NO_ELIGIBLE_TREE', '附近没有观测到带树叶的受支持原木');
        }
        woodType = best.type;
        ctx.report(`未指定树种，自动选择 ${woodType}`, { woodType });
      }
      const selectedType = woodType!;
      const leavesType = leavesFor(selectedType);
      baseline = inventoryCount(initial, selectedType);
      let tree: TreeFootprint | undefined;
      let pickupFailures = 0;
      const skippedTrees: TreeFootprint[] = [];
      const maxSkippedTrees = 6;
      let lastTargetFailure: { code: string; message: string } | undefined;
      const treeWasSkipped = (position: Point): boolean =>
        skippedTrees.some(skipped => withinTree(position, skipped));
      const exhausted = (): SkillRunResult<GatherWoodOutput> => {
        if (pickupFailures > 0) {
          return result('partial', 'PICKUP_UNCONFIRMED', '方块已挖掘，但没有观测到原木进入背包');
        }
        if (lastTargetFailure) {
          return result(
            collected > 0 ? 'partial' : 'blocked',
            'NO_REACHABLE_TARGET',
            `附近观测到目标原木，但都无法接近或挖掘（${lastTargetFailure.code}）`,
          );
        }
        return result(
          collected > 0 ? 'partial' : 'blocked',
          'NO_ELIGIBLE_TREE',
          `附近没有观测到带${leavesType}的${selectedType}`,
        );
      };
      const skipFailedTree = (
        error: unknown,
        target: Point,
        action: string,
      ): SkillRunResult<GatherWoodOutput> | undefined => {
        if (!(error instanceof SkillRunError)) throw error;
        // Cancellation, the skill deadline and a busy controller must stop the
        // run; they are not signs that the tree itself is unreachable.
        if (error.code === 'CANCELLED' || error.code === 'DEADLINE_EXCEEDED' || error.actionStatus === 'busy') {
          throw error;
        }
        lastTargetFailure = { code: error.code, message: error.message };
        skippedTrees.push(tree ?? { x: target.x, z: target.z });
        tree = undefined;
        ctx.report(`${action}失败，跳过这棵树`, { code: error.code, target });
        if (skippedTrees.length < maxSkippedTrees) return undefined;
        return result(
          collected > 0 ? 'partial' : 'blocked',
          'NO_REACHABLE_TARGET',
          `连续 ${skippedTrees.length} 棵树都无法接近或挖掘`,
        );
      };
      for (let iteration = 0; iteration < params.count * 3 + maxSkippedTrees; iteration++) {
        ctx.check();
        const current = snapshot();
        const total = inventoryCount(current, selectedType);
        collected = Math.max(0, total - baseline);
        if (collected >= params.count) {
          ctx.report(`已采集 ${collected}/${params.count} 个原木`, { collected, woodType: selectedType });
          return result('succeeded');
        }

        // Query only logs here. Leaves are only needed when choosing a new
        // tree, and mixing them into this query would hide upper trunk blocks.
        const logs = observedBlocks(ctx, [selectedType], params.searchRadius, 128);
        const footprint = tree;
        let candidates = footprint
          ? logs.filter(block => block.position && withinTree(block.position, footprint))
          : [];
        if (candidates.length === 0) {
          tree = undefined;
          const leaves = observedBlocks(ctx, [leavesType], params.searchRadius, 128);
          const eligible = eligibleLogs([...logs, ...leaves], selectedType, current.position)
            .filter(item => !treeWasSkipped(item.block.position!));
          if (eligible.length === 0) {
            return exhausted();
          }
          const chosen = eligible[0]!.block.position!;
          tree = { x: chosen.x, z: chosen.z };
          candidates = logs.filter(block => block.position && withinTree(block.position, tree!));
        }
        if (current.position) {
          candidates.sort((a, b) =>
            euclidean(current.position!, a.position!) - euclidean(current.position!, b.position!));
        }
        const target = candidates[0]?.position;
        if (!target) {
          return exhausted();
        }

        const before = inventoryCount(snapshot(), selectedType);
        ctx.report(`发现目标 ${selectedType} (${target.x}, ${target.y}, ${target.z})`, { target });
        // Approach at the current ground level instead of the trunk block's
        // altitude. Pathfinding to a log high in the canopy often fails even
        // though the block is within interaction reach from below.
        try {
          await ctx.execute({
            type: 'navigate',
            // blockPosition requires integers; feet can sit on a fractional
            // y after slabs, snow or stairs.
            position: { x: target.x, y: Math.floor(current.position?.y ?? target.y), z: target.z },
            range: 2,
          });
        } catch (error) {
          const failure = skipFailedTree(error, target, '接近目标');
          if (failure) return failure;
          continue;
        }
        const fresh = ctx.query<BlockObservation>({ type: 'inspect_block', position: target });
        if (!fresh.known || fresh.name !== selectedType) {
          return result(collected > 0 ? 'partial' : 'blocked', 'TARGET_CHANGED', '接近后目标方块已改变');
        }

        try {
          await ctx.execute({ type: 'dig', position: target });
        } catch (error) {
          const failure = skipFailedTree(error, target, '挖掘目标');
          if (failure) return failure;
          continue;
        }
        try {
          await collectNearbyDrops(ctx, {
            item: selectedType,
            count: 1,
            radius: 4,
            maxDrops: 2,
            waitMs: 1000,
            initialWaitMs: 600,
          });
        } catch (error) {
          if (error instanceof SkillRunError && (error.code === 'CANCELLED' || error.code === 'DEADLINE_EXCEEDED')) {
            throw error;
          }
          ctx.report('拾取阶段受阻', {
            code: error instanceof SkillRunError ? error.code : 'PICKUP_FAILED',
          });
        }

        const after = inventoryCount(snapshot(), selectedType);
        collected = Math.max(0, after - baseline);
        ctx.report(`采集进度 ${collected}/${params.count}`, { collected, woodType: selectedType });
        if (after <= before) {
          // A falling drop or a late inventory update can make one pickup
          // unconfirmed. Keep cutting; the next pickup pass may collect both.
          pickupFailures++;
          ctx.report('拾取未确认，继续寻找下一个目标', { collected, pickupFailures });
          if (pickupFailures >= 2) {
            return result('partial', 'PICKUP_UNCONFIRMED', '方块已挖掘，但没有观测到原木进入背包');
          }
          continue;
        }
        pickupFailures = 0;
      }
      return result('partial', 'ATTEMPT_LIMIT', '采集次数已达到上限');
    } catch (error) {
      const failure = error instanceof SkillRunError
        ? error
        : new SkillRunError('SKILL_FAILED', error instanceof Error ? error.message : String(error));
      const status: SkillStatus = failure.code === 'CANCELLED' ? 'cancelled' : 'failed';
      if (baseline !== undefined && woodType) {
        try {
          const current = snapshot();
          collected = Math.max(0, inventoryCount(current, woodType) - baseline);
        } catch {
          // Best-effort only; after cancellation the context refuses new queries.
        }
      }
      return {
        ...result(status, failure.code, failure.message),
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.actionStatus ? { actionStatus: failure.actionStatus } : {}),
        },
      };
    }
  },
};

/* -------------------------------------------------------------------------- */
/* find_resource                                                              */
/* -------------------------------------------------------------------------- */

const findResourceParams = z.object({
  names: z.array(z.string().min(1).max(100)).min(1).max(32),
  radius: z.number().int().min(1).max(32).default(16),
  limit: z.number().int().min(1).max(128).default(32),
}).strict();

export type FindResourceInput = z.input<typeof findResourceParams>;
export type FindResourceOutput = {
  blocks: BlockObservation[];
  scope: string;
  completeWorldSearch: boolean;
};

/** Read-only building block: returns observed candidates, never selects one. */
export const findResourceSkill: SkillDefinition<z.output<typeof findResourceParams>, FindResourceOutput> = {
  id: 'find_resource',
  description: '在已加载范围内寻找指定方块，返回候选位置',
  inputSchema: findResourceParams,
  supportedVersions: ['1.21.1'],
  risk: 'low',
  requiredCapabilities: ['observe'],
  idempotent: true,
  async run(params, ctx) {
    const found = ctx.query<FindResourceOutput>({
      type: 'find_blocks',
      names: params.names,
      radius: params.radius,
      limit: params.limit,
    });
    if (!Array.isArray(found?.blocks)) {
      return { status: 'failed', error: { code: 'OBSERVATION_UNAVAILABLE', message: '找方块查询没有返回候选列表' } };
    }
    return {
      status: 'succeeded',
      output: {
        blocks: found.blocks,
        scope: found.scope ?? 'loaded_client_chunks',
        completeWorldSearch: found.completeWorldSearch === true,
      },
    };
  },
};

/* -------------------------------------------------------------------------- */
/* craft_item                                                                 */
/* -------------------------------------------------------------------------- */

const containerPosition = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
}).strict();

const craftItemParams = z.object({
  item: z.string().min(1).max(100),
  count: z.number().int().min(1).max(2304).default(1),
  table: containerPosition.optional(),
  recipeRef: recipeRefSchema.optional(),
  searchRadius: z.number().int().min(1).max(16).default(16),
}).strict();

export type CraftItemInput = z.input<typeof craftItemParams>;
type CraftItemParams = z.output<typeof craftItemParams>;
export type CraftItemOutput = {
  item: string;
  requested: number;
  crafted: number;
  repetitions: number;
  resultPerCraft: number;
  table?: Point;
  recipeRef?: string;
  ingredients: Array<{ name: string; required: number; available: number | null }>;
};

type RecipeEntry = {
  result: { id?: number; name?: string | null; count: number };
  delta: Array<{ id?: number; name?: string | null; count: number }>;
  requiresTable?: boolean;
  recipeRef?: string;
};

/**
 * Craft a target output count. Recipes are read from the bot's own version
 * registry; material sufficiency and the final inventory delta are both checked.
 */
export const craftItemSkill: SkillDefinition<CraftItemParams, CraftItemOutput> = {
  id: 'craft_item',
  description: '按目标数量制作物品，检查材料与工作台，并核对产物增量',
  inputSchema: craftItemParams,
  supportedVersions: ['1.21.1'],
  risk: 'requires_confirmation',
  requiredCapabilities: ['observe', 'craft'],
  idempotent: false,
  async run(params, ctx) {
    const readRecipes = (table?: Point): { recipes?: RecipeEntry[]; error?: string } => {
      try {
        if (params.recipeRef) {
          const evaluation = ctx.query<{ recipe: RecipeRecord }>({
            type: 'recipe_evaluate', item: params.item, recipeRef: params.recipeRef,
            count: params.count, facilities: table ? ['crafting_table'] : [],
          });
          const record = evaluation.recipe;
          if (record.facility === 'crafting_table' && !table) return { recipes: [] };
          return { recipes: [{
            result: { name: record.result.item, count: record.result.count },
            delta: record.ingredients.map(input => ({ name: input.item, count: -input.count })),
            requiresTable: record.facility === 'crafting_table', recipeRef: record.recipeRef,
          }] };
        }
        return {
          recipes: ctx.query<RecipeEntry[]>({
            type: 'recipes',
            item: params.item,
            ...(table ? { table } : {}),
          }),
        };
      } catch (error) {
        if (error instanceof SkillRunError && (error.code === 'CANCELLED' || error.code === 'DEADLINE_EXCEEDED')) {
          throw error;
        }
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };
    const inspectTable = (position: Point): BlockObservation =>
      ctx.query<BlockObservation>({ type: 'inspect_block', position });

    let table = params.table ? floorPoint(params.table) : undefined;
    if (table) {
      const observed = inspectTable(table);
      if (!observed.known) {
        return {
          status: 'blocked',
          error: { code: 'TABLE_NOT_OBSERVED', message: '没有观测到指定位置的工作台' },
        };
      }
      if (observed.name !== 'crafting_table') {
        return {
          status: 'blocked',
          error: { code: 'NOT_CRAFTING_TABLE', message: `目标方块是 ${observed.name ?? '未知'}，不是工作台` },
        };
      }
      ctx.report(`前往工作台 (${table.x}, ${table.y}, ${table.z})`, { table });
      await ctx.execute({ type: 'navigate', position: table, range: 2 });
    }

    let lookup = readRecipes(table);
    if (!lookup.recipes && lookup.error) {
      return {
        status: 'blocked',
        error: { code: 'RECIPE_QUERY_FAILED', message: lookup.error },
      };
    }

    if (!table && (lookup.recipes?.length ?? 0) === 0) {
      const found = ctx.query<{ blocks: BlockObservation[] }>({
        type: 'find_blocks',
        names: ['crafting_table'],
        radius: params.searchRadius,
        limit: 8,
      });
      const candidate = (found.blocks ?? []).find(
        block => block.known && block.name === 'crafting_table' && block.position,
      )?.position;
      if (candidate) {
        table = floorPoint(candidate);
        const observed = inspectTable(table);
        if (!observed.known || observed.name !== 'crafting_table') {
          return {
            status: 'blocked',
            error: { code: 'NOT_CRAFTING_TABLE', message: '找到的方块已不是工作台' },
          };
        }
        ctx.report(`使用附近工作台 (${table.x}, ${table.y}, ${table.z})`, { table });
        await ctx.execute({ type: 'navigate', position: table, range: 2 });
        lookup = readRecipes(table);
        if (!lookup.recipes && lookup.error) {
          return {
            status: 'blocked',
            error: { code: 'RECIPE_QUERY_FAILED', message: lookup.error },
          };
        }
      }
    }

    const recipes = lookup.recipes ?? [];
    if (recipes.length === 0) {
      return {
        status: 'blocked',
        error: {
          code: 'NO_CRAFTABLE_RECIPE',
          message: '没有可制作配方：材料不足、缺少工作台，或当前版本没有该配方',
        },
      };
    }

    // Must match the craft action, which uses recipesFor(...)[0] internally.
    // Picking a different recipe here could check one ingredient set while the
    // native action consumes another.
    const recipe = recipes[0]!;
    const resultPerCraft = recipe.result.count;
    if (!Number.isInteger(resultPerCraft) || resultPerCraft <= 0) {
      return {
        status: 'failed',
        error: { code: 'INVALID_RECIPE', message: '配方产物数量无效' },
      };
    }

    const totalRepetitions = Math.ceil(params.count / resultPerCraft);
    const beforeSnapshot = ctx.query<Snapshot>({ type: 'snapshot', radius: 16 });
    const inventoryBefore = inventoryCount(beforeSnapshot, params.item);
    const ingredients = recipe.delta
      .filter(entry => entry.count < 0)
      .map(entry => ({
        name: entry.name ?? `item#${entry.id ?? '?'}`,
        required: -entry.count * totalRepetitions,
        available: entry.name ? inventoryCount(beforeSnapshot, entry.name) : null,
      }));
    const missing = ingredients.filter(entry => entry.available !== null && entry.available < entry.required);
    const baseOutput: CraftItemOutput = {
      item: params.item,
      requested: params.count,
      crafted: 0,
      repetitions: 0,
      resultPerCraft,
      ...(table ? { table } : {}),
      ingredients,
      ...(params.recipeRef ? { recipeRef: params.recipeRef } : {}),
    };
    if (missing.length > 0) {
      return {
        status: 'blocked',
        output: baseOutput,
        error: {
          code: 'INSUFFICIENT_MATERIALS',
          message: `材料不足: ${missing.map(entry => `${entry.name} 需要 ${entry.required}，现有 ${entry.available}`).join('；')}`,
        },
      };
    }

    ctx.report(`找到配方：每次产出 ${resultPerCraft} 个 ${params.item}，计划 ${totalRepetitions} 次`, {
      resultPerCraft,
      totalRepetitions,
      table,
    });

    let crafted = 0;
    let repetitions = 0;
    for (let chunk = 0; crafted < params.count && chunk < 64; chunk++) {
      ctx.check();
      const repetitionsThisRun = Math.min(64, Math.ceil((params.count - crafted) / resultPerCraft));
      await ctx.execute({
        type: 'craft',
        item: params.item,
        repetitions: repetitionsThisRun,
        ...(params.recipeRef ? { recipeRef: params.recipeRef } : {}),
        ...(table ? { table } : {}),
      });
      repetitions += repetitionsThisRun;
      const snapshot = ctx.query<Snapshot>({ type: 'snapshot', radius: 16 });
      crafted = Math.max(0, inventoryCount(snapshot, params.item) - inventoryBefore);
      ctx.report(`制作进度 ${Math.min(crafted, params.count)}/${params.count}`, {
        crafted,
        repetitions: repetitionsThisRun,
      });
    }

    const afterSnapshot = ctx.query<Snapshot>({ type: 'snapshot', radius: 16 });
    const finalCrafted = Math.max(0, inventoryCount(afterSnapshot, params.item) - inventoryBefore);
    const output: CraftItemOutput = {
      ...baseOutput,
      crafted: finalCrafted,
      repetitions,
    };
    if (finalCrafted < params.count) {
      return {
        status: finalCrafted > 0 ? 'partial' : 'failed',
        output,
        error: {
          code: finalCrafted > 0 ? 'CRAFT_OUTPUT_UNCONFIRMED' : 'CRAFT_LIMIT_REACHED',
          message: `制作结束，但只观测到 ${finalCrafted}/${params.count} 个 ${params.item}`,
        },
      };
    }
    return { status: 'succeeded', output };
  },
};

/* -------------------------------------------------------------------------- */
/* store_items                                                                */
/* -------------------------------------------------------------------------- */

const storeItemsParams = z.object({
  container: containerPosition,
  item: z.string().min(1).max(100),
  count: z.number().int().min(1).max(2304),
}).strict();

export type StoreItemsInput = z.output<typeof storeItemsParams>;
export type StoreItemsOutput = {
  container: Point;
  item: string;
  requested: number;
  containerBefore: number;
  containerAfter: number;
  inventoryBefore: number;
  inventoryAfter: number;
};

function containerCount(data: unknown, item: string): number {
  const items = (data as { items?: Array<{ item?: { name?: string; count?: number } | null }> } | undefined)?.items ?? [];
  return items
    .filter(entry => entry?.item?.name === item)
    .reduce((sum, entry) => sum + (entry.item?.count ?? 0), 0);
}

/** Deposit into a container and verify both sides of the transfer. */
export const storeItemsSkill: SkillDefinition<StoreItemsInput, StoreItemsOutput> = {
  id: 'store_items',
  description: '把指定数量的物品放进一个已观测容器，并核对背包与容器变化',
  inputSchema: storeItemsParams,
  supportedVersions: ['1.21.1'],
  risk: 'requires_confirmation',
  requiredCapabilities: ['container'],
  idempotent: false,
  async run(params, ctx) {
    const beforeSnapshot = ctx.query<Snapshot>({ type: 'snapshot', radius: 16 });
    const inventoryBefore = inventoryCount(beforeSnapshot, params.item);
    if (inventoryBefore < params.count) {
      return {
        status: 'blocked',
        error: { code: 'INSUFFICIENT_ITEMS', message: `背包里的 ${params.item} 不足 ${params.count} 个` },
      };
    }

    const beforeInspect = await ctx.execute({ type: 'container_inspect', position: params.container });
    const containerBefore = containerCount(beforeInspect.data, params.item);
    ctx.report(`准备存入 ${params.count} 个 ${params.item}`, { containerBefore, inventoryBefore });

    await ctx.execute({
      type: 'container_transfer',
      position: params.container,
      direction: 'deposit',
      item: params.item,
      count: params.count,
    });

    const afterInspect = await ctx.execute({ type: 'container_inspect', position: params.container });
    const afterSnapshot = ctx.query<Snapshot>({ type: 'snapshot', radius: 16 });
    const containerAfter = containerCount(afterInspect.data, params.item);
    const inventoryAfter = inventoryCount(afterSnapshot, params.item);
    const output: StoreItemsOutput = {
      container: params.container,
      item: params.item,
      requested: params.count,
      containerBefore,
      containerAfter,
      inventoryBefore,
      inventoryAfter,
    };
    ctx.report(`容器内 ${params.item}: ${containerBefore} → ${containerAfter}`, output);

    if (inventoryAfter !== inventoryBefore - params.count || containerAfter !== containerBefore + params.count) {
      return {
        status: 'partial',
        output,
        error: { code: 'TRANSFER_MISMATCH', message: '转移动作完成，但背包或容器的数量变化不符合预期' },
        partialEffects: [`已从背包取出 ${Math.max(0, inventoryBefore - inventoryAfter)} 个 ${params.item}`],
      };
    }
    return { status: 'succeeded', output };
  },
};

/* -------------------------------------------------------------------------- */
/* deliver_to_player                                                          */
/* -------------------------------------------------------------------------- */

const deliverToPlayerParams = z.object({
  item: z.string().min(1).max(100),
  count: z.number().int().min(1).max(2304).default(1),
  player: z.string().min(1).max(32).optional(),
  range: z.number().min(1).max(4).default(2),
}).strict();

export type DeliverToPlayerInput = z.input<typeof deliverToPlayerParams>;
type DeliverToPlayerParams = z.output<typeof deliverToPlayerParams>;
export type DeliverToPlayerOutput = {
  player: string;
  item: string;
  requested: number;
  /** null means a toss was attempted but the outcome could not be observed. */
  tossed: number | null;
  inventoryBefore: number | null;
  inventoryAfter: number | null;
  playerDistance: number | null;
  navigated: boolean;
  receipt: 'unverified';
};

function findPlayerEntity(snapshot: Snapshot, name: string): SnapshotEntity | undefined {
  const lower = name.toLowerCase();
  const entities = snapshot.entities ?? [];
  return entities.find(entity => entity.username?.toLowerCase() === lower)
    ?? entities.find(entity => !entity.username && entity.name?.toLowerCase() === lower);
}

/**
 * Toss items near a player. Client observation can verify the inventory left
 * the bot and the player was nearby, but cannot confirm the player picked it up.
 */
export const deliverToPlayerSkill: SkillDefinition<DeliverToPlayerParams, DeliverToPlayerOutput> = {
  id: 'deliver_to_player',
  description: '接近指定玩家并丢出物品；只能证明物品离开背包，不能证明对方已拾取',
  inputSchema: deliverToPlayerParams,
  supportedVersions: ['1.21.1'],
  risk: 'requires_confirmation',
  requiredCapabilities: ['observe', 'navigate', 'toss'],
  idempotent: false,
  async run(params, ctx) {
    const target = params.player ?? ctx.player;
    if (!target) {
      return {
        status: 'blocked',
        error: { code: 'NO_DELIVERY_TARGET', message: '没有指定交付玩家，也没有请求者信息' },
      };
    }

    let inventoryBefore: number | null = null;
    let playerDistance: number | null = null;
    let navigated = false;
    let tossAttempted = false;
    try {
      const before = ctx.query<Snapshot>({ type: 'snapshot', radius: 16 });
      inventoryBefore = inventoryCount(before, params.item);
      if (inventoryBefore < params.count) {
        return {
          status: 'blocked',
          output: {
            player: target,
            item: params.item,
            requested: params.count,
            tossed: 0,
            inventoryBefore,
            inventoryAfter: inventoryBefore,
            playerDistance: null,
            navigated: false,
            receipt: 'unverified',
          },
          error: { code: 'INSUFFICIENT_ITEMS', message: `背包里的 ${params.item} 不足 ${params.count} 个` },
        };
      }
      if (!before.position) {
        return {
          status: 'blocked',
          error: { code: 'POSITION_UNOBSERVED', message: '无法读取当前位置' },
        };
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        ctx.check();
        const snapshot = attempt === 0 ? before : ctx.query<Snapshot>({ type: 'snapshot', radius: 16 });
        const entity = findPlayerEntity(snapshot, target);
        if (!entity?.position) {
          return {
            status: 'blocked',
            output: {
              player: target,
              item: params.item,
              requested: params.count,
              tossed: 0,
              inventoryBefore,
              inventoryAfter: inventoryBefore,
              playerDistance: null,
              navigated,
              receipt: 'unverified',
            },
            error: {
              code: attempt === 0 ? 'PLAYER_NOT_OBSERVED' : 'PLAYER_LOST',
              message: `没有观测到玩家 ${target}`,
            },
          };
        }
        const origin = snapshot.position ?? before.position;
        const distance = euclidean(origin, entity.position);
        if (distance <= params.range + 1) {
          playerDistance = distance;
          break;
        }
        if (attempt === 1) {
          return {
            status: 'blocked',
            output: {
              player: target,
              item: params.item,
              requested: params.count,
              tossed: 0,
              inventoryBefore,
              inventoryAfter: inventoryBefore,
              playerDistance: distance,
              navigated,
              receipt: 'unverified',
            },
            error: { code: 'PLAYER_UNREACHABLE', message: `无法接近玩家 ${target}` },
          };
        }
        ctx.report(`接近玩家 ${target}`, { distance });
        await ctx.execute({
          type: 'navigate',
          position: floorPoint(entity.position),
          range: params.range,
        });
        navigated = true;
      }

      ctx.report(`已接近 ${target}，准备丢出 ${params.count} 个 ${params.item}`);
      tossAttempted = true;
      await ctx.execute({ type: 'toss', item: params.item, count: params.count });

      const after = ctx.query<Snapshot>({ type: 'snapshot', radius: 16 });
      const inventoryAfter = inventoryCount(after, params.item);
      const tossed = Math.max(0, (inventoryBefore ?? 0) - inventoryAfter);
      const output: DeliverToPlayerOutput = {
        player: target,
        item: params.item,
        requested: params.count,
        tossed,
        inventoryBefore,
        inventoryAfter,
        playerDistance,
        navigated,
        receipt: 'unverified',
      };
      if (tossed !== params.count) {
        return {
          status: 'partial',
          output,
          error: { code: 'TRANSFER_MISMATCH', message: '丢出动作完成，但背包减少数量不符合预期' },
        };
      }
      ctx.report(
        `已丢出 ${tossed} 个 ${params.item}，距离 ${playerDistance?.toFixed(2) ?? '未知'}；客户端无法确认对方是否拾取`,
        { receipt: 'unverified' },
      );
      return { status: 'succeeded', output };
    } catch (error) {
      if (error instanceof SkillRunError && (error.code === 'CANCELLED' || error.code === 'DEADLINE_EXCEEDED')) {
        return {
          status: 'cancelled',
          output: {
            player: target,
            item: params.item,
            requested: params.count,
            tossed: tossAttempted ? null : 0,
            inventoryBefore,
            inventoryAfter: tossAttempted ? null : inventoryBefore,
            playerDistance,
            navigated,
            receipt: 'unverified',
          },
          error: {
            code: error.code,
            message: error.message,
            ...(error.actionStatus ? { actionStatus: error.actionStatus } : {}),
          },
          partialEffects: tossAttempted
            ? [`已请求丢出 ${params.count} 个 ${params.item}，取消后无法确认背包变化`]
            : [],
        };
      }
      throw error;
    }
  },
};

/* -------------------------------------------------------------------------- */
/* Registry and compatibility entry points                                    */
/* -------------------------------------------------------------------------- */

export const navigateToParamsSchema = navigateToParams;
export const collectDropsParamsSchema = collectDropsParams;
export const craftItemParamsSchema = craftItemParams;
export const deliverToPlayerParamsSchema = deliverToPlayerParams;
export const findResourceParamsSchema = findResourceParams;
export const gatherWoodParamsSchema = gatherWoodParams;
export const storeItemsParamsSchema = storeItemsParams;

export const DEFAULT_SKILLS = new SkillRegistry();
DEFAULT_SKILLS.register(gatherWoodSkill);
DEFAULT_SKILLS.register(findResourceSkill);
DEFAULT_SKILLS.register(storeItemsSkill);
DEFAULT_SKILLS.register(navigateToSkill);
DEFAULT_SKILLS.register(collectDropsSkill);
DEFAULT_SKILLS.register(craftItemSkill);
DEFAULT_SKILLS.register(deliverToPlayerSkill);
const DEFAULT_RUNNER = new SkillRunner(DEFAULT_SKILLS);

export type GatherResult = {
  status: ControllerStatus;
  requested: number;
  collected: number;
  woodType: string | null;
  actions: ActionResult[];
  error?: { code: string; message: string };
};

/**
 * Backwards-compatible entry point for tests and small callers. The real
 * controller uses SkillRunner with the shared registry.
 */
export async function gatherWood(
  port: ActionPort,
  params: GatherWoodInput,
  signal: AbortSignal,
  deadline?: number,
): Promise<GatherResult> {
  const context = createSkillContext(port, { signal, ...(deadline !== undefined ? { deadline } : {}) });
  const result = await DEFAULT_RUNNER.run<GatherWoodParams, GatherWoodOutput>('gather_wood', params, context);
  return {
    status: skillStatusToController(result),
    requested: params.count ?? 1,
    collected: result.output?.collected ?? 0,
    woodType: result.output?.woodType ?? null,
    actions: actionEvidence(result),
    ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
  };
}
