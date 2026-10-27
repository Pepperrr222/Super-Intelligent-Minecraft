'use strict'

const { ActionError } = require('../errors')
const { resolveItem } = require('../game')
const { countOf } = require('../inventory')
const {
  CHEST_BLOCKS,
  CHEST_WINDOW_TYPES,
  openContainerAt,
  containerItems,
  containerCounts,
  windowInventoryCounts,
  windowInventoryList
} = require('../containers')

async function run (ctx, args) {
  const bot = ctx.bot
  if (!bot.entity) throw new ActionError('NOT_CONNECTED', 'Bot is not spawned')
  const item = resolveItem(bot, args.item)
  const deposit = args.kind === 'deposit'
  let window = null

  try {
    const opened = await openContainerAt(ctx, args.position, CHEST_BLOCKS, CHEST_WINDOW_TYPES, 'chest/barrel')
    window = opened.window

    // While a container window is open, bot.inventory is only a stale copy.
    // The window's player-inventory slots are the live state.
    const beforeInventory = windowInventoryCounts(window)
    const beforeContainer = containerCounts(window)
    const available = deposit ? countOf(beforeInventory, args.item) : countOf(beforeContainer, args.item)
    if (available < args.count) {
      throw new ActionError(
        deposit ? 'INSUFFICIENT_ITEMS' : 'INSUFFICIENT_CONTAINER_ITEMS',
        deposit
          ? `Inventory has ${available} ${args.item}, need ${args.count}`
          : `Container has ${available} ${args.item}, need ${args.count}`
      )
    }

    ctx.setEffect({
      item: args.item,
      requested_count: args.count,
      container_type: window.type,
      actual_moved: 0,
      inventory_before: windowInventoryList(window),
      container_before: containerItems(window)
    })

    try {
      ctx.check()
      if (deposit) {
        if (typeof window.deposit !== 'function') throw new Error('window does not support deposit')
        await ctx.wait(window.deposit(item.id, null, args.count))
      } else {
        if (typeof window.withdraw !== 'function') throw new Error('window does not support withdraw')
        await ctx.wait(window.withdraw(item.id, null, args.count))
      }
    } catch (err) {
      if (ctx.token.cancelled) throw err
      throw new ActionError('TRANSFER_FAILED', `Could not ${args.kind} ${args.item}: ${err.message}`)
    }
    await ctx.sleep(150)
    ctx.check()

    const afterInventory = windowInventoryCounts(window)
    const afterContainer = containerCounts(window)
    const inventoryDelta = countOf(afterInventory, args.item) - countOf(beforeInventory, args.item)
    const containerDelta = countOf(afterContainer, args.item) - countOf(beforeContainer, args.item)
    const inventoryMoved = deposit ? -inventoryDelta : inventoryDelta
    const containerMoved = deposit ? containerDelta : -containerDelta
    const actualMoved = Math.max(0, Math.min(inventoryMoved, containerMoved))

    ctx.setEffect({
      actual_moved: actualMoved,
      inventory_delta: inventoryDelta,
      container_delta: containerDelta,
      inventory_after: windowInventoryList(window),
      container_after: containerItems(window)
    })

    if (actualMoved === 0) {
      throw new ActionError('NO_EFFECT', `No ${args.item} actually moved`)
    }
    if (inventoryDelta !== (deposit ? -args.count : args.count) ||
        containerDelta !== (deposit ? args.count : -args.count)) {
      throw new ActionError('TRANSFER_INCOMPLETE',
        `Moved ${actualMoved} of ${args.count} ${args.item} (inventory ${inventoryDelta >= 0 ? '+' : ''}${inventoryDelta}, container ${containerDelta >= 0 ? '+' : ''}${containerDelta})`)
    }

    ctx.markVerified({ actual_moved: actualMoved })
  } finally {
    ctx.closeWindow()
  }
}

module.exports = { run }
