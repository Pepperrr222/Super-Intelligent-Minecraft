import { RecipeKnowledgeError, type RecipeIngredient, type RecipeProvider, type RecipeRecord } from './recipes.js';

export type RequirementsInput = {
  goals: RecipeIngredient[];
  mode: 'total' | 'additional';
  facilities: string[];
  maxDepth: number;
  maxNodes: number;
  maxAlternatives: number;
  recipeRefs?: Record<string, string>;
};
type Missing = RecipeIngredient & { reason: 'resource' | 'cycle' | 'depth_limit' | 'node_limit' };
type Operation =
  | { kind: 'craft'; item: string; recipeRef: string; batches: number; outputCount: number; facility: string }
  | { kind: 'place_facility'; item: 'crafting_table' };
type State = { stock: Map<string, number>; facilities: Set<string>; operations: Operation[]; missing: Missing[] };

/** Pure, bounded dependency expansion. It never selects world targets or executes actions. */
export function expandRequirements(
  provider: RecipeProvider,
  input: RequirementsInput,
  inventory: readonly RecipeIngredient[],
  check: () => void = () => {},
  protectedInventory: readonly RecipeIngredient[] = [],
) {
  const stock = new Map<string, number>();
  for (const item of inventory) stock.set(item.item, (stock.get(item.item) ?? 0) + item.count);
  const recipes = new Map<string, readonly RecipeRecord[]>();
  const lookup = (item: string) => {
    check();
    if (!recipes.has(item)) recipes.set(item, provider.lookup(item));
    return recipes.get(item)!;
  };
  const goals = new Map<string, number>();
  for (const goal of input.goals) goals.set(goal.item, (goals.get(goal.item) ?? 0) + goal.count);
  // Additional goals reserve pre-existing target items before sharing the working inventory.
  const reserved = new Map<string, number>();
  if (input.mode === 'additional') for (const item of goals.keys()) {
    reserved.set(item, stock.get(item) ?? 0); stock.set(item, 0);
  }
  const state: State = { stock, facilities: new Set(input.facilities), operations: [], missing: [] };
  let visited = 0;
  let truncated = false;
  let alternativesTruncated = false;
  const selectedRefs = new Set<string>();
  const clone = (s: State): State => ({ stock: new Map(s.stock), facilities: new Set(s.facilities),
    operations: [...s.operations], missing: [...s.missing] });
  // Ranking only: reachability ignores shared quantities. Actual expansion below reserves them.
  const reachable = new Map<string, number>();
  const distance = (item: string, path: Set<string>, depth: number): number => {
    check();
    if ((stock.get(item) ?? 0) > 0) return 0;
    if (path.has(item) || depth > 5) return 100;
    const key = `${item}:${depth}`;
    if (reachable.has(key)) return reachable.get(key)!;
    // Independent cap bounds the heuristic as well as the actual expansion.
    if (reachable.size >= input.maxNodes * 4) return 100;
    reachable.set(key, 100);
    const next = new Set(path).add(item);
    const candidates = lookup(item);
    const cost = candidates.length === 0 ? 100 : Math.min(...candidates.map(recipe =>
      1 + recipe.ingredients.reduce((sum, ingredient) => sum + distance(ingredient.item, next, depth + 1), 0)));
    reachable.set(key, cost);
    return cost;
  };
  const score = (s: State) => s.missing.reduce((sum, item) => sum + item.count, 0);
  const acquire = (item: string, count: number, s: State, path: Set<string>, depth: number): void => {
    check();
    if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
      throw new RecipeKnowledgeError('REQUIREMENT_QUANTITY_LIMIT', '递归数量超过安全计算上限，请缩小目标');
    }
    const taken = Math.min(s.stock.get(item) ?? 0, count);
    s.stock.set(item, (s.stock.get(item) ?? 0) - taken);
    const needed = count - taken;
    if (needed <= 0) return;
    const reason = path.has(item) ? 'cycle' : depth > input.maxDepth ? 'depth_limit'
      : visited >= input.maxNodes ? 'node_limit' : null;
    if (reason) {
      if (reason !== 'cycle') truncated = true;
      s.missing.push({ item, count: needed, reason }); return;
    }
    visited++;
    let candidates = [...lookup(item)];
    const requestedRef = input.recipeRefs?.[item];
    if (requestedRef) {
      candidates = candidates.filter(recipe => recipe.recipeRef === requestedRef);
      if (candidates.length === 0) throw new RecipeKnowledgeError('STALE_RECIPE', `配方引用不适用于 ${item}`);
      selectedRefs.add(item);
    }
    const ranked = candidates.map(recipe => ({ recipe, rank: recipe.ingredients.reduce((sum, ingredient) =>
        sum + Math.max(0, ingredient.count * Math.ceil(needed / recipe.result.count) - (s.stock.get(ingredient.item) ?? 0))
          * distance(ingredient.item, new Set(), 0), 0) }));
    ranked.sort((a, b) => a.rank - b.rank || a.recipe.recipeRef.localeCompare(b.recipe.recipeRef));
    candidates = ranked.map(entry => entry.recipe);
    if (candidates.length === 0) { s.missing.push({ item, count: needed, reason: 'resource' }); return; }
    if (candidates.length > input.maxAlternatives) alternativesTruncated = true;
    let best: State | undefined;
    const next = new Set(path).add(item);
    for (const recipe of candidates.slice(0, input.maxAlternatives)) {
      check();
      const trial = clone(s);
      const batches = Math.ceil(needed / recipe.result.count);
      if (recipe.facility === 'crafting_table' && !trial.facilities.has('crafting_table')) {
        acquire('crafting_table', 1, trial, next, depth + 1);
        trial.operations.push({ kind: 'place_facility', item: 'crafting_table' });
        trial.facilities.add('crafting_table');
      }
      for (const ingredient of recipe.ingredients) acquire(ingredient.item, ingredient.count * batches, trial, next, depth + 1);
      trial.operations.push({ kind: 'craft', item, recipeRef: recipe.recipeRef, batches,
        outputCount: batches * recipe.result.count, facility: recipe.facility });
      trial.stock.set(item, (trial.stock.get(item) ?? 0) + batches * recipe.result.count - needed);
      if (!best || score(trial) < score(best)
        || score(trial) === score(best) && trial.operations.length < best.operations.length) best = trial;
      if (best.missing.length === s.missing.length) break;
    }
    if (best) Object.assign(s, best);
    else s.missing.push({ item, count: needed, reason: 'node_limit' });
  };
  for (const [item, count] of goals) {
    const protectedCount = protectedInventory.filter(i=>i.item===item).reduce((sum,i)=>sum+i.count,0);
    const owned = input.mode==='total' ? Math.min(count,protectedCount) : 0;
    if(protectedCount) reserved.set(item,(reserved.get(item) ?? 0)+protectedCount);
    if(count>owned) acquire(item, count-owned, state, new Set(), 0);
  }
  const missing = new Map<string, Missing>();
  for (const entry of state.missing) {
    const key = `${entry.item}:${entry.reason}`;
    missing.set(key, { ...entry, count: (missing.get(key)?.count ?? 0) + entry.count });
  }
  return {
    source: provider.source, version: provider.version, revision: provider.revision,
    mode: input.mode, goals: [...goals].map(([item, count]) => ({ item, count })),
    status: truncated ? 'incomplete' : missing.size ? 'needs_resources' : 'resolved',
    operations: state.operations, missing: [...missing.values()],
    inventoryRemaining: [...state.stock].filter(([, count]) => count > 0).map(([item, count]) => ({ item, count })),
    reservedExisting: [...reserved].filter(([, count]) => count > 0).map(([item, count]) => ({ item, count })),
    assumedFacilities: input.facilities,
    truncated, alternativesTruncated, visited,
    unusedRecipeSelections: Object.keys(input.recipeRefs ?? {}).filter(item => !selectedRefs.has(item)),
    executable: false,
    notes: ['依赖候选需要重新核对材料与设施；放置和获取叶子资源由上层规划执行',
      '仅覆盖本数据源的合成规则，不包含采集工具等级、燃料、返还容器和服务器自定义规则',
      '缺料基于当前选中分支；未保证最优，替代搜索截断时不证明所有方案都缺料'],
  };
}
