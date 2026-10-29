'use strict'

const { ActionError } = require('../errors')
const { resolveBlock, resolveItem, findBlocks, ensureNearBlock } = require('../game')
const { inventoryCounts, countOf, deltaFor, canonicalName } = require('../inventory')

const TABLE_RADIUS = 32

function selectRecipe (recipes) {
  return [...recipes].sort((a, b) => {
    if (Boolean(a.requiresTable) !== Boolean(b.requiresTable)) {
      return a.requiresTable ? 1 : -1
    }
    return (b.result.count || 1) - (a.result.count || 1)
  })[0]
}

async function findCraftingTable (ctx) {
  const table = resolveBlock(ctx.bot, 'minecraft:crafting_table')
  const candidates = findBlocks(ctx.bot, [table.id], TABLE_RADIUS, 4)
  for (const candidate of candidates) {
    const block = ctx.bot.blockAt(candidate.position)
    if (!block || block.type !== table.id) continue
    try {
      await ensureNearBlock(ctx, block)
      const fresh = ctx.bot.blockAt(candidate.position)
      if (fresh && fresh.type === table.id) return fresh
    } catch (err) {
      if (ctx.token.cancelled) throw err
      // Try another table within the bounded local search.
    }
  }
  return null
}

async function syncWindow (ctx, window) {
  if (!window) return false
  if (typeof ctx.bot._syncWindow !== 'function') {
    await ctx.sleep(50)
    return false
  }
  try {
    await ctx.wait(ctx.bot._syncWindow(window))
    return true
  } catch (err) {
    if (ctx.token.cancelled) throw err
    return false
  }
}

async function syncInventory (ctx) {
  if (ctx.bot.currentWindow) return false
  return syncWindow(ctx, ctx.bot.inventory)
}

function closeCurrentWindow (bot) {
  const window = bot.currentWindow
  if (!window) return false
  try {
    if (typeof window.close === 'function') window.close()
    else bot.closeWindow(window)
    return true
  } catch {
    return false
  }
}

function hasRoomFor (window, item) {
  if (!window || !item) return false
  if (typeof window.findItemRange === 'function') {
    const existing = window.findItemRange(
      window.inventoryStart,
      window.inventoryEnd,
      item.type,
      item.metadata,
      true,
      item.nbt
    )
    if (existing) return true
  }
  return typeof window.emptySlotCount === 'function' ? window.emptySlotCount() > 0 : true
}

/**
 * Mineflayer's last put-away click is unconfirmed.  On 1.17+ a rejected click
 * can leave the crafted result on the cursor (which is not persisted by the
 * server) even though the ingredients are gone.  Force an authoritative window
 * sync, recover a result left in the output slot or on the cursor, then sync
 * again before measuring the inventory.
 */
async function recoverCraftingState (ctx) {
  const bot = ctx.bot
  const recovery = {
    output_recovered: false,
    cursor_recovered: false,
    cursor_blocked: false,
    synced: false
  }

  if (bot.currentWindow) {
    closeCurrentWindow(bot)
    await ctx.sleep(50)
  }

  recovery.synced = await syncInventory(ctx)
  const window = bot.inventory
  if (!window) return recovery

  const output = window.slots ? window.slots[0] : null
  if (output) {
    if (hasRoomFor(window, output)) {
      try {
        await ctx.wait(bot.putAway(0))
        await ctx.sleep(50)
        await syncInventory(ctx)
        recovery.output_recovered = true
      } catch (err) {
        if (ctx.token.cancelled) throw err
      }
    } else {
      recovery.cursor_blocked = true
    }
  }

  if (window.selectedItem) {
    if (hasRoomFor(window, window.selectedItem)) {
      try {
        await ctx.wait(bot.putSelectedItemRange(
          window.inventoryStart,
          window.inventoryEnd,
          window,
          null
        ))
        await ctx.sleep(50)
        await syncInventory(ctx)
        recovery.cursor_recovered = true
      } catch (err) {
        if (ctx.token.cancelled) throw err
      }
    } else {
      recovery.cursor_blocked = true
    }
  }

  return recovery
}

async function run (ctx, args) {
  const bot = ctx.bot
  if (!bot.entity) throw new ActionError('NOT_CONNECTED', 'Bot is not spawned')

  // Never start crafting on top of a stale container window.  Then ask the
  // server for the real player-inventory state (this also refreshes the stateId
  // used by subsequent window clicks).
  if (bot.currentWindow) {
    closeCurrentWindow(bot)
    await ctx.sleep(50)
  }
  const syncedBefore = await syncInventory(ctx)

  const item = resolveItem(bot, args.item)
  let before = inventoryCounts(bot)

  let recipes = bot.recipesFor(item.id, null, args.count, null)
  recipes = recipes.concat(bot.recipesFor(item.id, null, args.count, true).filter((recipe) => recipe.requiresTable))

  if (recipes.length === 0) {
    const known = bot.recipesAll(item.id, null, true)
    if (!known || known.length === 0) {
      throw new ActionError('UNKNOWN_RECIPE', `No recipe produces ${args.item}`)
    }
    throw new ActionError('MISSING_INGREDIENTS', `Not enough ingredients to craft ${args.count} ${args.item}`)
  }

  const recipe = selectRecipe(recipes)
  const perCraft = recipe.result.count || 1
  const repeats = Math.ceil(args.count / perCraft)

  // Prefer a real crafting table when one is nearby: Mineflayer's table path
  // syncs and closes the window before copying the inventory back, which is
  // more robust than the 2x2 inventory window for this failure mode.
  let table = await findCraftingTable(ctx)
  if (!table && recipe.requiresTable) {
    throw new ActionError('MISSING_CRAFTING_TABLE', 'Recipe requires a crafting table within the search radius')
  }

  if (table) {
    const current = bot.blockAt(table.position)
    if (!current || current.type !== table.type) table = null
    if (!table && recipe.requiresTable) {
      throw new ActionError('MISSING_CRAFTING_TABLE', 'Crafting table disappeared before use')
    }
  }

  before = inventoryCounts(bot)
  ctx.setEffect({
    item: args.item,
    requested_count: args.count,
    recipe_result_count: perCraft,
    crafts: repeats,
    requires_table: Boolean(recipe.requiresTable),
    used_table: Boolean(table),
    inventory_before_count: countOf(before, args.item),
    inventory_synced_before: syncedBefore,
    crafting_table: table
      ? { x: table.position.x, y: table.position.y, z: table.position.z }
      : null
  })

  let craftError = null
  let recovery = {}
  // Reconcile each recipe batch with the server before putting down the next
  // ingredients. A speculative multi-craft can otherwise lose later batches
  // on modern stateId windows while appearing successful to Mineflayer.
  for (let batch = 0; batch < repeats; batch++) {
    ctx.check()
    const prior = countOf(inventoryCounts(bot), args.item)
    try {
      await ctx.wait(bot.craft(recipe, 1, table))
    } catch (err) {
      if (ctx.token.cancelled) throw err
      craftError = err
    }
    recovery = await recoverCraftingState(ctx)
    await syncInventory(ctx)
    const actual = countOf(inventoryCounts(bot), args.item)
    ctx.setEffect({ completed_batches: batch + 1, produced_count: actual - countOf(before, args.item) })
    if (actual - prior < perCraft || craftError) break
  }

  await ctx.sleep(50)
  ctx.check()

  const after = inventoryCounts(bot)
  const produced = deltaFor(before, after, args.item)
  ctx.setEffect({
    produced_count: produced,
    inventory_after_count: countOf(after, args.item),
    output_recovered: recovery.output_recovered,
    cursor_recovered: recovery.cursor_recovered,
    cursor_blocked: recovery.cursor_blocked,
    inventory_synced_after: recovery.synced
  })

  if (produced < args.count && craftError) {
    throw new ActionError('CRAFT_FAILED', `Crafting ${args.item} failed: ${craftError.message}`)
  }
  if (produced < args.count) {
    throw new ActionError('CRAFT_INCOMPLETE',
      `Only ${produced} of the requested ${args.count} ${args.item} were produced` +
      (recovery.cursor_blocked ? ' (craft result was stuck on the cursor with no inventory room)' : ''))
  }

  ctx.markVerified({ produced_count: produced })
}

module.exports = { run, recoverCraftingState, syncInventory }
