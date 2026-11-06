import { evaluateRecipe, recipeReference, RecipeKnowledgeError, type RecipeProvider, type RecipeRecord, type RecipeIngredient } from './recipes.js';
import { expandRequirements, type RequirementsInput } from './requirements.js';

/** Short, content-addressed handles. The full hash remains internal; collisions fail closed. */
export const recipeHandle = (r: RecipeRecord) => `recipe:${r.recipeRef.slice(0, 16)}`;
export function resolveRecipeHandle(provider: RecipeProvider, item: string, ref: string): RecipeRecord {
  const matches = provider.lookup(item).filter(r => r.recipeRef === ref || recipeHandle(r) === ref);
  const unique = new Map(matches.map(r => [r.recipeRef, r]));
  if (unique.size !== 1) throw new RecipeKnowledgeError('RECIPE_PRODUCT_MISMATCH', '配方编号不属于当前产物或版本，请使用 crafting_options 返回的编号');
  return [...unique.values()][0]!;
}

// These are display labels only. Membership ALWAYS comes from actual recipes, never suffix inference.
const label = (name: string) => name.endsWith('_planks') ? '木板组' : name.endsWith('_log') ? '原木组' : name;
export function recipeGroups(records: readonly RecipeRecord[], inventory: readonly RecipeIngredient[], expandMembers: boolean) {
  const groups = new Map<string, RecipeRecord[]>();
  for (const record of records) {
    const signature = JSON.stringify([record.facility, record.result,
      record.ingredients.map(i => ({ label: label(i.item), count: i.count })).sort((a,b) => a.label.localeCompare(b.label))]);
    const group = groups.get(signature) ?? []; group.push(record); groups.set(signature, group);
  }
  return [...groups.values()].map(records => {
    const first = records[0]!;
    const ingredients = first.ingredients.map(input => {
      const members = [...new Set(records.flatMap(r => r.ingredients.filter(i => label(i.item) === label(input.item) && i.count === input.count).map(i => i.item)))].sort();
      return { label: label(input.item), count: input.count, memberCount: members.length,
        availableMembers: inventory.filter(i => members.includes(i.item)), ...(expandMembers ? { members } : {}) };
    });
    return { groupId: recipeReference(records.map(r => r.recipeRef).sort()).slice(0,16), result: first.result,
      facility: first.facility, ingredients, variants: records.length,
      source: 'derived_from_exact_recipes', freelyMixable: false,
      constraint: '显示分组不授权任意混搭；执行只能选择下列经真实配方匹配的方案' };
  });
}

/** Pure arithmetic and bounded alternatives; no world reads/writes or acquisition policy. */
export function craftingOptions(provider: RecipeProvider, input: RequirementsInput & { includeDependencies: boolean; expandMembers: boolean }, inventory: RecipeIngredient[], protectedInventory: RecipeIngredient[] = []) {
  const totals = new Map<string, number>();
  for (const goal of input.goals) totals.set(goal.item, (totals.get(goal.item) ?? 0) + goal.count);
  const available = new Map<string, number>();
  for (const i of inventory) available.set(i.item, (available.get(i.item) ?? 0) + i.count);
  const goals = [...totals].map(([item, count]) => {
    const records = provider.lookup(item);
    const owned = (available.get(item) ?? 0) + protectedInventory.filter(i=>i.item===item).reduce((n,i)=>n+i.count,0);
    const requested = input.mode === 'total' ? Math.max(0, count - owned) : count;
    // Reserve existing target output for total AND additional semantics.
    available.set(item, 0);
    return { item, count, requested, owned, records };
  });
  const results = goals.map(({ item, count, requested, owned, records }) => {
    const stock = [...available].map(([item, count]) => ({ item, count }));
    const ranked = records.map(record => evaluateRecipe(record, requested, stock, input.facilities))
      .sort((a,b) => a.ingredients.reduce((n,i) => n+i.missing,0)-b.ingredients.reduce((n,i) => n+i.missing,0)
        || a.recipe.recipeRef.localeCompare(b.recipe.recipeRef));
    const selected = ranked[0];
    if (selected) for (const i of selected.ingredients) available.set(i.item, Math.max(0, (available.get(i.item) ?? 0) - i.required));
    return { item, count, requested, owned, ownershipOnly:true, groups: recipeGroups(records, stock, input.expandMembers),
      materialsReady: requested === 0 || !!selected && selected.ingredients.every(i => i.missing === 0),
      alternativesTotal: ranked.length, alternativesTruncated: ranked.length > 3,
      alternatives: ranked.slice(0,3).map(({recipe,...evaluation}) => ({ ...evaluation,
        recipe: { recipeRef: recipeHandle(recipe), result: recipe.result, facility: recipe.facility },
        facilityObserved: false })),
      allocation: selected ? recipeHandle(selected.recipe) : null };
  });
  const dependencies = input.includeDependencies ? expandRequirements(provider, input, inventory, undefined, protectedInventory) : undefined;
  if (dependencies) for (const op of dependencies.operations) if (op.kind === 'craft') {
    op.recipeRef = recipeHandle(resolveRecipeHandle(provider, op.item, op.recipeRef));
  }
  return { source: provider.source, version: provider.version, revision: provider.revision,
    scope: 'local_version_rules', serverRulesVerified: false, facilityObserved: false,
    checkedAt: Date.now(), mode: input.mode, goals: results, materialsReady: results.every(r => r.materialsReady),
    allocationPolicy: '目标顺序共享库存；候选不足不证明所有组合不足；候选方案不能同时消费同一库存',
    inventoryRemaining: [...available].filter(([,count]) => count > 0).map(([item,count]) => ({item,count})),
    ...(dependencies ? { dependencies } : {}), executable: false };
}
