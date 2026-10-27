'use strict'

const { ActionError } = require('./errors')
const { canonicalName, countItems } = require('./inventory')
const { ensureNearBlock, distanceToBlock, getVec3 } = require('./game')

const CHEST_BLOCKS = new Set(['chest', 'trapped_chest', 'barrel'])
const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker'])
// 1.21.1 prismarine-windows reports chest/barrel windows as generic_9xN
// (generic_9x3 for one chest/barrel, generic_9x6 for a double chest).  Keep the
// legacy names as well so older protocol builds remain usable.
const CHEST_WINDOW_TYPES = new Set([
  'minecraft:chest',
  'minecraft:barrel',
  'minecraft:generic',
  'minecraft:generic_9x1',
  'minecraft:generic_9x2',
  'minecraft:generic_9x3',
  'minecraft:generic_9x4',
  'minecraft:generic_9x5',
  'minecraft:generic_9x6'
])
const FURNACE_WINDOW_TYPES = new Set(['minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker'])

function blockAtPosition (bot, position) {
  const Vec3 = getVec3(bot)
  return bot.blockAt(new Vec3(position.x, position.y, position.z))
}

function checkWindowType (window, allowedTypes) {
  const type = window && typeof window.type === 'string' ? window.type : ''
  if (!allowedTypes.has(type)) {
    throw new ActionError('WRONG_CONTAINER', `Unexpected container window ${type || 'unknown'}`)
  }
}

async function validateContainerTarget (ctx, position, allowedBlocks, label) {
  ctx.check()
  const block = blockAtPosition(ctx.bot, position)
  if (!block || block.type === 0) {
    throw new ActionError('CONTAINER_NOT_FOUND', `No ${label} block at ${position.x},${position.y},${position.z}`)
  }
  if (!allowedBlocks.has(block.name)) {
    throw new ActionError('INVALID_CONTAINER', `Block at target is ${block.name}, not a supported ${label}`)
  }
  await ensureNearBlock(ctx, block)
  const fresh = blockAtPosition(ctx.bot, position)
  if (!fresh || fresh.name !== block.name) {
    throw new ActionError('CONTAINER_CHANGED', 'Container block changed before opening')
  }
  if (distanceToBlock(ctx.bot, fresh) > 4.5) {
    throw new ActionError('OUT_OF_REACH', 'Container is out of reach')
  }
  return fresh
}

function installWindow (ctx, window, allowedWindowTypes) {
  if (!window) throw new ActionError('CONTAINER_OPEN_FAILED', 'Server did not open a container window')
  try {
    checkWindowType(window, allowedWindowTypes)
  } catch (err) {
    try {
      if (typeof window.close === 'function') window.close()
      else ctx.bot.closeWindow(window)
    } catch {
      // ignore
    }
    throw err
  }
  ctx.setWindow(window)
  return window
}

async function openContainerAt (ctx, position, allowedBlocks, allowedWindowTypes, label = 'container') {
  const block = await validateContainerTarget(ctx, position, allowedBlocks, label)
  let window
  try {
    window = await ctx.wait(ctx.bot.openBlock(block))
  } catch (err) {
    if (ctx.token.cancelled) throw err
    throw new ActionError('CONTAINER_OPEN_FAILED', `Could not open ${block.name}: ${err.message}`)
  }
  return { block, window: installWindow(ctx, window, allowedWindowTypes) }
}

async function openFurnaceAt (ctx, position) {
  const block = await validateContainerTarget(ctx, position, FURNACE_BLOCKS, 'furnace')
  let window
  try {
    window = await ctx.wait(ctx.bot.openFurnace(block))
  } catch (err) {
    if (ctx.token.cancelled) throw err
    throw new ActionError('CONTAINER_OPEN_FAILED', `Could not open ${block.name}: ${err.message}`)
  }
  return { block, window: installWindow(ctx, window, FURNACE_WINDOW_TYPES) }
}

function containerItems (window, options = {}) {
  const items = []
  const source = typeof window.containerItems === 'function'
    ? window.containerItems()
    : (window.slots || []).slice(0, window.inventoryStart)
  for (const item of source) {
    if (!item) continue
    items.push({
      slot: item.slot,
      name: canonicalName(item.name),
      count: item.count
    })
  }
  if (options.includeEmpty) {
    const bySlot = new Map(items.map((item) => [item.slot, item]))
    return Array.from({ length: window.inventoryStart }, (_, slot) => bySlot.get(slot) || { slot, name: null, count: 0 })
  }
  return items
}

function containerCounts (window) {
  return countItems(typeof window.containerItems === 'function'
    ? window.containerItems()
    : (window.slots || []).slice(0, window.inventoryStart))
}

function windowInventoryItems (window) {
  return (window.slots || []).slice(window.inventoryStart, window.inventoryEnd).filter(Boolean)
}

function windowInventoryCounts (window) {
  return countItems(windowInventoryItems(window))
}

function windowInventoryList (window) {
  return [...windowInventoryCounts(window).entries()]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count }))
}

async function transferWithinWindow (ctx, window, options) {
  try {
    await ctx.wait(ctx.bot.transfer({ window, ...options }))
  } catch (err) {
    if (ctx.token.cancelled) throw err
    throw new ActionError('TRANSFER_FAILED', `Container transfer failed: ${err.message}`)
  }
  ctx.check()
}

async function moveIntoSlot (ctx, window, itemType, count, destStart, destEnd) {
  await transferWithinWindow(ctx, window, {
    itemType,
    metadata: null,
    count,
    sourceStart: window.inventoryStart,
    sourceEnd: window.inventoryEnd,
    destStart,
    destEnd
  })
}

async function takeFromSlot (ctx, window, itemType, count, sourceStart, sourceEnd) {
  await transferWithinWindow(ctx, window, {
    itemType,
    metadata: null,
    count,
    sourceStart,
    sourceEnd,
    destStart: window.inventoryStart,
    destEnd: window.inventoryEnd
  })
}

module.exports = {
  CHEST_BLOCKS,
  FURNACE_BLOCKS,
  CHEST_WINDOW_TYPES,
  FURNACE_WINDOW_TYPES,
  blockAtPosition,
  openContainerAt,
  openFurnaceAt,
  containerItems,
  containerCounts,
  windowInventoryItems,
  windowInventoryCounts,
  windowInventoryList,
  transferWithinWindow,
  moveIntoSlot,
  takeFromSlot
}
