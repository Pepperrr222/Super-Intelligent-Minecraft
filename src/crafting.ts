import type { Bot } from 'mineflayer';
import { ActionError, type Context } from './executor.js';
import { BotRecipeProvider, evaluateRecipe, planningInventory, specialMaterial } from './recipes.js';

type CraftRequest = { item: string; recipeRef?: string; repetitions?: number; outputCount?: number };
type CraftingBot = Bot & { _syncWindow?: (window: Bot['inventory']) => Promise<void> };

/** One native craft call, one reconciliation, no automatic retry or recipe substitution. */
export async function craftWithEvidence(bot: Bot, c: Context, request: CraftRequest, table?: NonNullable<ReturnType<Bot['blockAt']>>) {
  c.check();
  if (bot.currentWindow) throw new ActionError('WINDOW_BUSY', '合成前必须关闭已有窗口');
  if (bot.inventory.selectedItem) throw new ActionError('CURSOR_OCCUPIED', '合成前光标不能持有物品');
  const type = bot.registry.itemsByName[request.item]?.id;
  if (type == null) throw new ActionError('UNKNOWN_ITEM', `未知物品: ${request.item}`);
  const selected = request.recipeRef ? new BotRecipeProvider(bot).resolve(request.item, request.recipeRef) : undefined;
  const recipe = selected?.native ?? bot.recipesFor(type, null, 1, table ?? null)[0];
  if (!recipe) throw new ActionError('NO_RECIPE', '材料不足或没有可用配方/工作台');
  if (recipe.requiresTable && !table) throw new ActionError('CRAFTING_TABLE_REQUIRED', '选定配方需要已观测到的工作台');
  const repetitions = request.repetitions ?? Math.ceil(request.outputCount! / recipe.result.count);
  const expected = repetitions * recipe.result.count;
  const before = planningInventory(bot);
  if (selected && bot.inventory.items().some(i=>selected.record.ingredients.some(r=>r.item===i.name) && specialMaterial(i)))
    throw new ActionError('SPECIAL_MATERIAL_SELECTION_REQUIRED','原料存在特殊属性；名称级合成无法保证不消耗它，请先将需要保留的物品分开存放');
  if (selected && !evaluateRecipe(selected.record, expected, before, table ? ['crafting_table'] : []).craftable) {
    throw new ActionError('INSUFFICIENT_MATERIALS', '指定配方的材料不足，未发送合成请求');
  }
  // Check the entire batch even on the compatibility path, not only one repetition.
  for (const delta of recipe.delta ?? []) {
    if (delta.count >= 0) continue;
    const available = bot.inventory.items().filter(item => item.type === delta.id
      && (delta.metadata == null || item.metadata === delta.metadata)).reduce((sum, item) => sum + item.count, 0);
    if (available < -delta.count * repetitions) throw new ActionError('INSUFFICIENT_MATERIALS', '整批合成所需材料不足，未发送合成请求');
  }
  const amount = (items: ReturnType<typeof planningInventory>) => items.filter(item => item.item === request.item)
    .reduce((sum, item) => sum + item.count, 0);
  let apiComplete = false;
  let reconciled = false;
  const receipt = () => {
    const after = planningInventory(bot);
    return { evidence: 'client_inventory', requestSent: true, apiComplete, reconciled,
      item: request.item, repetitions, expected, gained: amount(after) - amount(before),
      inventoryBefore: before, inventoryAfter: after,
      ...(request.recipeRef ? { recipeRef: request.recipeRef } : {}) };
  };
  c.check();
  try {
    await bot.craft(recipe, repetitions, table); c.check();
    apiComplete = true;
    // 4.39.0 already synchronizes table crafting. Also reconcile the player
    // inventory after hand crafting, where the last click may only be predicted.
    const sync = (bot as CraftingBot)._syncWindow;
    if (sync) { c.check(); await sync.call(bot, bot.inventory); c.check(); reconciled = true; }
  } catch (error) {
    c.check();
    throw new ActionError(apiComplete ? 'CRAFT_RECONCILIATION_FAILED' : 'CRAFT_API_FAILED',
      apiComplete ? '合成 API 已结束，但背包对账失败；请重新观察后再决定下一步' : '合成 API 失败，可能已有部分效果；请先检查背包',
      { ...receipt(), needsReconciliation: true });
  }
  const data = receipt();
  if (data.gained < expected) throw new ActionError('INVENTORY_MISMATCH', '合成后的背包增量未达到预期',
    { ...data, needsReconciliation: !reconciled });
  return { ...data, evidence: 'inventory_delta', ...(request.outputCount ? { requested: request.outputCount } : {}) };
}
