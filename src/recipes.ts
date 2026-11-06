import { createHash } from 'node:crypto';
import type { Bot } from 'mineflayer';

export type NativeRecipe = ReturnType<Bot['recipesAll']>[number];
export type RecipeIngredient = { item: string; count: number };
/** Name-only recipe matching cannot safely choose among decorated/damaged variants. */
export function specialMaterial(item:any):boolean {
  try {
    return !!(item?.nbt || item?.customName || item?.enchants?.length || item?.durabilityUsed || item?.metadata
      || (item?.components && Object.keys(item.components).length));
  } catch { return true; }
}
export type RecipeRecord = {
  recipeRef: string;
  source: string;
  version: string;
  revision: string;
  kind: 'crafting';
  result: RecipeIngredient;
  ingredients: RecipeIngredient[];
  facility: 'inventory' | 'crafting_table';
};

/** Versioned knowledge, independent of inventory, observed facilities and execution. */
export interface RecipeProvider {
  readonly source: string;
  readonly version: string;
  readonly revision: string;
  lookup(item: string): readonly RecipeRecord[];
}

/** Read the active GUI inventory when present; the closed-window mirror may be stale. */
export function planningInventory(bot: Bot): RecipeIngredient[] {
  const window = bot.currentWindow;
  const items = window ? window.slots.slice(window.inventoryStart, window.inventoryEnd) : bot.inventory.items();
  return items.flatMap(item => item ? [{ item: item.name, count: item.count }] : []);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]),
  );
  return value;
}

/** A content reference changes with the recipe, provider revision or Minecraft version. */
export function recipeReference(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export class RecipeKnowledgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class BotRecipeProvider implements RecipeProvider {
  private cache = new Map<string, RecipeRecord[]>();
  private cacheVersion = '';
  readonly source = 'mineflayer_local_registry';
  readonly revision = 'mineflayer-4.39.0/crafting-v1';
  get version() { return this.bot.version ?? 'unknown'; }
  constructor(private readonly bot: Bot) {}

  /** `true` describes a theoretical crafting facility; it is never an observed block. */
  private native(item: string): NativeRecipe[] {
    const entry = this.bot.registry.itemsByName[item];
    if (!entry) throw new RecipeKnowledgeError('UNKNOWN_ITEM', `未知物品: ${item}`);
    return this.bot.recipesAll(entry.id, null, true);
  }

  private describe(native: NativeRecipe): RecipeRecord {
    const name = (id: number) => {
      const entry = this.bot.registry.items[id];
      if (!entry) throw new RecipeKnowledgeError('UNSUPPORTED_RECIPE', `配方含未知物品编号: ${id}`);
      return entry.name;
    };
    // Count required input slots, not net deltas that can hide reusable inputs.
    // Returned containers/byproducts are not yet added to planning inventory.
    const inputs = native.inShape ? native.inShape.flat() : native.ingredients;
    const counts = new Map<string, number>();
    for (const input of inputs ?? []) {
      if (input.id < 0) continue;
      // Native crafting matches metadata, but the v1 planning inventory is name-only.
      if (input.metadata != null && input.metadata !== 0) {
        throw new RecipeKnowledgeError('UNSUPPORTED_RECIPE', '当前知识接口不支持带特殊 metadata 的配方');
      }
      const item = name(input.id);
      const count = Math.abs(input.count);
      if (!Number.isSafeInteger(count) || count < 1) throw new RecipeKnowledgeError('UNSUPPORTED_RECIPE', '配方原料数量无效');
      counts.set(item, (counts.get(item) ?? 0) + count);
    }
    if (!Number.isSafeInteger(native.result.count) || native.result.count < 1) {
      throw new RecipeKnowledgeError('UNSUPPORTED_RECIPE', '配方产量无效');
    }
    const base = {
      source: this.source, version: this.version, revision: this.revision,
      kind: 'crafting' as const,
      result: { item: name(native.result.id), count: native.result.count },
      ingredients: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([item, count]) => ({ item, count })),
      facility: native.requiresTable ? 'crafting_table' as const : 'inventory' as const,
    };
    return { ...base, recipeRef: recipeReference({ ...base, native }) };
  }

  lookup(item: string): RecipeRecord[] {
    const version = `${this.source}:${this.version}:${this.revision}`;
    if (version !== this.cacheVersion) { this.cache.clear(); this.cacheVersion = version; }
    if (!this.cache.has(item)) {
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(item, this.native(item).map(recipe => this.describe(recipe)));
    }
    return structuredClone(this.cache.get(item)!);
  }

  resolve(item: string, recipeRef: string): { native: NativeRecipe; record: RecipeRecord } {
    for (const native of this.native(item)) {
      const record = this.describe(native);
      if (record.recipeRef === recipeRef) return { native, record };
    }
    throw new RecipeKnowledgeError('STALE_RECIPE', '配方引用不属于当前物品、版本或配方修订，请重新查询');
  }
}

export function evaluateRecipe(
  recipe: RecipeRecord,
  count: number,
  inventory: readonly RecipeIngredient[],
  facilities: readonly string[],
) {
  const batches = Math.ceil(count / recipe.result.count);
  const available = new Map<string, number>();
  for (const item of inventory) available.set(item.item, (available.get(item.item) ?? 0) + item.count);
  const ingredients = recipe.ingredients.map(input => ({
    item: input.item, required: input.count * batches, available: available.get(input.item) ?? 0,
    missing: Math.max(0, input.count * batches - (available.get(input.item) ?? 0)),
  }));
  const missingFacility = recipe.facility !== 'inventory' && !facilities.includes(recipe.facility)
    ? recipe.facility : null;
  return { recipe, requested: count, batches, outputCount: batches * recipe.result.count,
    ingredients, missingFacility, craftable: !missingFacility && ingredients.every(input => input.missing === 0) };
}
