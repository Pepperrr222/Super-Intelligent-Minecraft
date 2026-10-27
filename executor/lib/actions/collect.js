'use strict'

const { ActionError } = require('../errors')
const {
  resolveBlock,
  findBlocks,
  ensureNearBlock,
  digBlock,
  gotoPosition,
  distanceToBlock,
  distanceToPoint,
  getVec3
} = require('../game')
const { inventoryCounts, diffCounts } = require('../inventory')

const SEARCH_RADIUS = 32
const TERMINAL_ERRORS = new Set(['MISSING_TOOL', 'CANNOT_DIG', 'NOT_CONNECTED'])
const DROP_PICKUP_MAX_MS = 30000
const DROP_STABLE_MS = 2000
const DROP_NEAR_RADIUS = 8
const PICKUP_RANGE = 0.75

function isDroppedItem (entity) {
  const name = entity && typeof entity.name === 'string' ? entity.name.toLowerCase() : ''
  return name === 'item' || name === 'item_stack'
}

function pendingDropsNear (bot, minedPositions) {
  if (!bot.entities) return []
  const pending = []
  for (const entity of Object.values(bot.entities)) {
    if (!entity || !isDroppedItem(entity) || !entity.position) continue
    let nearest = Infinity
    for (const position of minedPositions) {
      const dx = entity.position.x - (position.x + 0.5)
      const dy = entity.position.y - (position.y + 0.5)
      const dz = entity.position.z - (position.z + 0.5)
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (distance < nearest) nearest = distance
    }
    if (nearest <= DROP_NEAR_RADIUS) {
      pending.push({ entity, distance: nearest })
    }
  }
  pending.sort((a, b) => a.distance - b.distance)
  return pending.map((entry) => entry.entity)
}

function hasPositiveDelta (delta) {
  return Object.values(delta).some((value) => value > 0)
}

function groundTarget (bot, mined) {
  const Vec3 = getVec3(bot)
  const minY = bot.game && typeof bot.game.minY === 'number' ? bot.game.minY : -64
  for (let y = mined.y; y >= minY; y--) {
    const block = bot.blockAt(new Vec3(mined.x, y, mined.z))
    if (block && block.boundingBox === 'block') {
      return { x: mined.x + 0.5, y: y + 1, z: mined.z + 0.5 }
    }
  }
  return { x: mined.x + 0.5, y: mined.y + 1, z: mined.z + 0.5 }
}

async function approachDrop (ctx, entity, minedPositions) {
  ctx.check()
  const position = entity.position
  try {
    await gotoPosition(ctx, { x: position.x, y: position.y, z: position.z }, PICKUP_RANGE)
    return true
  } catch (err) {
    if (ctx.token.cancelled) throw err
    // An item may be falling or sitting above a block; retry at the nearest
    // mined block's ground column, which is normally walkable.
    let nearest = null
    let nearestDistance = Infinity
    for (const mined of minedPositions) {
      const distance = distanceToPoint(position, { x: mined.x + 0.5, y: mined.y + 0.5, z: mined.z + 0.5 })
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = mined
      }
    }
    if (!nearest) throw err
    await gotoPosition(ctx, nearest, PICKUP_RANGE)
    return false
  }
}

/**
 * Mining is only half of "collect": walk to the dropped item entities (or their
 * mined ground position), wait for the actual pickup, and report the real
 * inventory delta.  Timeouts and stop are checked after every await.
 */
async function pickupDrops (ctx, before, minedPositions) {
  const started = Date.now()
  let stableSince = Date.now()
  let last = inventoryCounts(ctx.bot)
  let pending = []
  let approachErrors = 0
  let sweepErrors = 0
  let swept = 0

  // Give the server a moment to send the item entities after the final break.
  await ctx.sleep(500)

  while (Date.now() - started < DROP_PICKUP_MAX_MS) {
    ctx.check()
    const current = inventoryCounts(ctx.bot)
    if (Object.keys(diffCounts(last, current)).length > 0) stableSince = Date.now()
    last = current

    pending = pendingDropsNear(ctx.bot, minedPositions)
    ctx.setEffect({
      inventory_delta: diffCounts(before, current),
      pending_drops: pending.length,
      drop_pickup_ms: Date.now() - started
    })
    if (pending.length === 0) {
      if (!hasPositiveDelta(diffCounts(before, current)) && swept < minedPositions.length) {
        // Item entities can be missed or merge with an existing stack.  Sweep
        // the ground under each mined block and let the normal pickup range
        // do the rest.
        const mined = minedPositions[swept++]
        try {
          await gotoPosition(ctx, groundTarget(ctx.bot, mined), PICKUP_RANGE)
          sweepErrors = 0
        } catch (err) {
          if (ctx.token.cancelled) throw err
          sweepErrors++
          if (sweepErrors >= minedPositions.length + 2) {
            throw new ActionError('DROP_UNREACHABLE',
              'Could not reach the mined positions to pick up dropped items')
          }
        }
        await ctx.sleep(400)
        continue
      }
      if (Date.now() - stableSince >= DROP_STABLE_MS) break
      await ctx.sleep(200)
      continue
    }

    const target = pending[0]
    try {
      await approachDrop(ctx, target, minedPositions)
      approachErrors = 0
    } catch (err) {
      if (ctx.token.cancelled) throw err
      approachErrors++
      if (approachErrors >= 5) {
        throw new ActionError('DROP_UNREACHABLE',
          'Dropped items are nearby but could not be reached for pickup')
      }
    }
    await ctx.sleep(300)
  }

  ctx.check()
  const after = inventoryCounts(ctx.bot)
  pending = pendingDropsNear(ctx.bot, minedPositions)
  return {
    inventory_delta: diffCounts(before, after),
    pending_drops: pending.length,
    pickup_ms: Date.now() - started
  }
}

async function run (ctx, args) {
  const bot = ctx.bot
  if (!bot.entity) throw new ActionError('NOT_CONNECTED', 'Bot is not spawned')
  const blockInfo = resolveBlock(bot, args.block)
  const before = inventoryCounts(bot)
  const minedPositions = []
  let mined = 0
  let attempts = 0
  let lastError = null
  const maxAttempts = Math.max(12, args.count * 6)

  ctx.setEffect({
    block: args.block,
    requested_count: args.count,
    mined_count: 0,
    inventory_delta: {}
  })

  while (mined < args.count) {
    ctx.check()
    if (attempts >= maxAttempts) break
    attempts++

    const candidates = findBlocks(bot, [blockInfo.id], SEARCH_RADIUS, Math.min(64, Math.max(8, args.count * 4)))
    if (candidates.length === 0) {
      lastError = new ActionError('BLOCK_NOT_FOUND', `No ${args.block} found within ${SEARCH_RADIUS} blocks`)
      break
    }

    let target = null
    for (const candidate of candidates) {
      const current = bot.blockAt(candidate.position)
      if (current && current.type === blockInfo.id && distanceToBlock(bot, current) <= SEARCH_RADIUS + 2) {
        target = current
        break
      }
    }
    if (!target) {
      lastError = new ActionError('BLOCK_NOT_FOUND', `No reachable ${args.block} candidate`)
      continue
    }

    try {
      await ensureNearBlock(ctx, target)
      const fresh = bot.blockAt(target.position)
      if (!fresh || fresh.type !== blockInfo.id) {
        // The block vanished or changed while walking; try the next one.
        continue
      }
      await digBlock(ctx, fresh)
      mined++
      minedPositions.push({ x: fresh.position.x, y: fresh.position.y, z: fresh.position.z })
      ctx.setEffect({ mined_count: mined })
      await ctx.sleep(100)
    } catch (err) {
      if (ctx.token.cancelled) throw err
      if (err instanceof ActionError && TERMINAL_ERRORS.has(err.code)) throw err
      lastError = err
    }
  }

  const picked = mined > 0
    ? await pickupDrops(ctx, before, minedPositions)
    : { inventory_delta: {}, pending_drops: 0, pickup_ms: 0 }

  ctx.setEffect({
    mined_count: mined,
    inventory_delta: picked.inventory_delta,
    drop_pickup_ms: picked.pickup_ms,
    pending_drops: picked.pending_drops
  })

  if (mined < args.count) {
    if (lastError && lastError.code === 'BLOCK_NOT_FOUND' && mined === 0) {
      throw lastError
    }
    throw new ActionError('COLLECT_INCOMPLETE',
      `Mined ${mined} of ${args.count} ${args.block} blocks` +
      (lastError ? `: ${lastError.message}` : ''))
  }
  if (picked.pending_drops > 0) {
    throw new ActionError('DROPS_NOT_PICKED_UP',
      `Mined ${mined} blocks but ${picked.pending_drops} dropped item entit${picked.pending_drops === 1 ? 'y is' : 'ies are'} still on the ground`)
  }
  if (!hasPositiveDelta(picked.inventory_delta)) {
    throw new ActionError('NO_INVENTORY_GAIN',
      `Mined ${mined} ${args.block} blocks but the inventory did not gain any item`)
  }

  ctx.markVerified({
    mined_count: mined,
    inventory_delta: picked.inventory_delta,
    drop_pickup_ms: picked.pickup_ms,
    pending_drops: picked.pending_drops
  })
}

module.exports = { run, pendingDropsNear, hasPositiveDelta, groundTarget }
