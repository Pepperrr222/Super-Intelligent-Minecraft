'use strict'

const { gotoPosition, distanceToPoint, getVec3 } = require('../game')
const { canonicalName, inventoryCounts, diffCounts } = require('../inventory')

function droppedName (entity) {
  try {
    const item = typeof entity.getDroppedItem === 'function' ? entity.getDroppedItem() : null
    return item ? canonicalName(item.name) : null
  } catch { return null } // Metadata may arrive after the entity spawn.
}

function pendingDropsNear (bot, positions, expected = null) {
  return Object.values(bot.entities || {}).filter(e => {
    if (!e || !['item', 'item_stack'].includes((e.name || '').toLowerCase()) || !e.position) return false
    const name = droppedName(e)
    if (name && expected && !expected.has(name)) return false
    return positions.some(p => distanceToPoint(e.position, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }) <= 12)
  }).sort((a, b) => Number(!droppedName(a)) - Number(!droppedName(b)) || distanceToPoint(bot.entity && bot.entity.position, a.position) -
                    distanceToPoint(bot.entity && bot.entity.position, b.position) || Number(a.id) - Number(b.id))
}

function gainFor (before, after, expected) {
  return [...expected].reduce((sum, name) => sum + Math.max(0, (after.get(name) || 0) - (before.get(name) || 0)), 0)
}

function safeFeet (bot, x, y, z) {
  const Vec3 = getVec3(bot)
  const floor = bot.blockAt(new Vec3(x, y - 1, z))
  const feet = bot.blockAt(new Vec3(x, y, z))
  const head = bot.blockAt(new Vec3(x, y + 1, z))
  return floor && feet && head && floor.boundingBox === 'block' &&
    !['magma_block', 'cactus', 'campfire', 'soul_campfire'].includes(floor.name) &&
    feet.boundingBox === 'empty' && head.boundingBox === 'empty' && !feet.liquid && !head.liquid &&
    ![feet.name, head.name].some(name => ['water', 'lava', 'fire', 'soul_fire', 'powder_snow'].includes(name))
}

function pickupPositions (bot, drop) {
  const points = []
  for (let x = Math.floor(drop.x) - 1; x <= Math.floor(drop.x) + 1; x++) {
    for (let z = Math.floor(drop.z) - 1; z <= Math.floor(drop.z) + 1; z++) {
      for (let y = Math.floor(drop.y) + 1; y >= Math.floor(drop.y) - 2; y--) {
        const point = { x: x + 0.5, y, z: z + 0.5 }
        if (distanceToPoint(point, drop) <= 1.5 && safeFeet(bot, x, y, z)) points.push(point)
      }
    }
  }
  return points.sort((a, b) => distanceToPoint(bot.entity.position, a) - distanceToPoint(bot.entity.position, b) || a.y - b.y)
}

function groundTarget (bot, mined) {
  const minY = Math.max(bot.game?.minY ?? -64, Math.floor(mined.y) - 32)
  for (let y = Math.floor(mined.y) + 1; y >= minY; y--) {
    if (safeFeet(bot, Math.floor(mined.x), y, Math.floor(mined.z))) {
      return { x: Math.floor(mined.x) + 0.5, y, z: Math.floor(mined.z) + 0.5 }
    }
  }
  return null // Unknown or obstructed columns are not guessed as walkable.
}

function createPickupSession () {
  return { attempts: 0, elapsed: 0, failed: new Set(), swept: new Set(), diagnostics: [] }
}

function note (session, entry) {
  session.diagnostics.push(entry)
  if (session.diagnostics.length > 16) session.diagnostics.shift()
}

async function pickupDrops (ctx, before, positions, expected, wanted, session, options = {}) {
  const now = options.now || Date.now
  const navigate = options.navigate || gotoPosition
  const started = now()
  const budget = Math.min(options.maxMs || 30000, Math.max(0, 30000 - session.elapsed))
  let idle = 0
  try {
    await ctx.sleep(250) // Allow falling drops and metadata to arrive before selecting a goal.
    while (now() - started < budget && session.attempts < 64) {
      ctx.check()
      const current = inventoryCounts(ctx.bot)
      const gained = gainFor(before, current, expected)
      const pending = pendingDropsNear(ctx.bot, positions, expected)
      ctx.setEffect({ phase: 'pickup', inventory_delta: diffCounts(before, current), gained_count: gained,
        pending_drops: pending.length, unidentified_drops: pending.filter(e => !droppedName(e)).length,
        drop_pickup_ms: session.elapsed + now() - started, pickup_attempts: session.attempts,
        pickup_diagnostics: session.diagnostics.slice(), bot_position: { ...ctx.bot.entity.position } })
      if (gained >= wanted && (!options.requireClear || (pending.length === 0 && idle >= 4))) break
      let selected = null
      for (const drop of pending) {
        const signature = `${drop.id}:${Math.floor(drop.position.x * 2)},${Math.floor(drop.position.y * 2)},${Math.floor(drop.position.z * 2)}`
        const points = pickupPositions(ctx.bot, drop.position)
        if (!points.length && !session.failed.has(signature)) {
          session.failed.add(signature)
          note(session, { entity_id: drop.id, item: droppedName(drop), drop_position: { ...drop.position }, result: 'NO_STANDABLE_APPROACH' })
        }
        for (const point of points) {
          const key = `${signature}:${point.x},${point.y},${point.z}`
          if (!session.failed.has(key)) { selected = { drop, point, key }; break }
        }
        if (selected) break
      }
      if (!selected && pending.length === 0 && gained < wanted) {
        // Entity updates can be missed; sweep only genuinely standable mined columns, once each.
        for (const position of positions) {
          const point = groundTarget(ctx.bot, position)
          if (!point) continue
          const key = `ground:${point.x},${point.y},${point.z}`
          if (!session.swept.has(key)) {
            session.swept.add(key); selected = { point, key }; break
          }
        }
      }
      if (!selected) {
        if (++idle >= 8 && pending.length === 0) break
        await ctx.sleep(250); continue // Falling/moving items may acquire a new standable goal.
      }
      idle = 0
      const { drop, point, key } = selected
      const oldPosition = drop && { ...drop.position }
      session.failed.add(key) // Even reaching a goal without pickup must try another approach.
      session.attempts++
      ctx.setEffect({ pickup_target: { entity_id: drop ? drop.id : null, item: drop ? droppedName(drop) : null,
        drop_position: oldPosition || null, approach: point, observed_at_ms: now() } })
      try {
        await navigate(ctx, point, 0.45, { isObsolete: () => {
          if (!drop) return false
          const live = ctx.bot.entities[drop.id]
          return !live || distanceToPoint(live.position, oldPosition) > 0.75
        } })
        ctx.check()
        await ctx.sleep(350)
        const after = gainFor(before, inventoryCounts(ctx.bot), expected)
        note(session, { entity_id: drop ? drop.id : null, item: drop ? droppedName(drop) : null,
          drop_position: oldPosition || null, approach: point, result: after > gained ? 'inventory_gain' : 'no_target_gain' })
      } catch (err) {
        if (ctx.token.cancelled) throw err
        note(session, { entity_id: drop ? drop.id : null, drop_position: oldPosition || null,
          approach: point, result: err.code || 'PATHFIND_FAILED' })
      }
    }
  } finally {
    session.elapsed += Math.max(0, now() - started)
    ctx.setEffect({ inventory_delta: diffCounts(before, inventoryCounts(ctx.bot)),
      gained_count: gainFor(before, inventoryCounts(ctx.bot), expected), drop_pickup_ms: session.elapsed,
      pickup_diagnostics: session.diagnostics.slice(), pickup_attempts: session.attempts })
  }
  return { inventory_delta: diffCounts(before, inventoryCounts(ctx.bot)), gained_count: gainFor(before, inventoryCounts(ctx.bot), expected),
    pending_drops: pendingDropsNear(ctx.bot, positions, expected).length, pickup_ms: session.elapsed }
}

module.exports = { droppedName, pendingDropsNear, gainFor, safeFeet, pickupPositions, groundTarget, createPickupSession, pickupDrops }
