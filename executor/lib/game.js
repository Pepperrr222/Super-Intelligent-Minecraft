'use strict'

const { ActionError } = require('./errors')
const { canonicalName } = require('./inventory')

function resolveItem (bot, canonicalId) {
  const key = canonicalId.startsWith('minecraft:') ? canonicalId.slice('minecraft:'.length) : canonicalId
  const item = bot.registry.itemsByName[key]
  if (!item) throw new ActionError('UNKNOWN_ITEM', `Unknown item ${canonicalId}`)
  return item
}

function resolveBlock (bot, canonicalId) {
  const key = canonicalId.startsWith('minecraft:') ? canonicalId.slice('minecraft:'.length) : canonicalId
  const block = bot.registry.blocksByName[key]
  if (!block) throw new ActionError('UNKNOWN_BLOCK', `Unknown block ${canonicalId}`)
  return block
}

function blockName (block) {
  return block ? canonicalName(block.name) : null
}

function distanceToPoint (entityPosition, point) {
  if (!entityPosition || !point) return Infinity
  const dx = entityPosition.x - point.x
  const dy = entityPosition.y - point.y
  const dz = entityPosition.z - point.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function blockCenter (block) {
  return { x: block.position.x + 0.5, y: block.position.y + 0.5, z: block.position.z + 0.5 }
}

function distanceToBlock (bot, block) {
  if (!bot.entity) return Infinity
  return distanceToPoint(bot.entity.position, blockCenter(block))
}

function getPathfinder () {
  try {
    return require('mineflayer-pathfinder')
  } catch (err) {
    throw new ActionError('PATHFINDER_UNAVAILABLE', 'mineflayer-pathfinder is not installed')
  }
}

function getVec3 (bot) {
  // Prefer Mineflayer's own Vec3 implementation so objects passed to the
  // world/pathfinder have the exact class their installed copy expects.
  if (bot && bot.entity && bot.entity.position && bot.entity.position.constructor) {
    return bot.entity.position.constructor
  }
  try {
    return require('vec3').Vec3
  } catch (err) {
    throw new ActionError('VEC3_UNAVAILABLE', 'vec3 is not installed')
  }
}

function configureMovements (bot, MovementsClass) {
  const Movements = MovementsClass || getPathfinder().Movements
  const movements = new Movements(bot)
  // Required by the contract: navigation must never mine or place a route.
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowFreeMotion = false
  // Pathfinder defaults to dirt/cobblestone as bridging material; no block
  // placement is allowed on a navigation route.
  movements.scafoldingBlocks = []
  bot.pathfinder.setMovements(movements)
  bot.pathfinder.thinkTimeout = 5000
  bot.pathfinder.tickTimeout = 40
  return movements
}

function makePointGoal (position, range, GoalClass = getPathfinder().goals.Goal) {
  // Pathfinder nodes use block corners, but players stand near block centers.
  // GoalNear checks integer nodes and can stop over a block outside the actual
  // requested sphere. Use the same world-space metric as the verifier.
  return new (class extends GoalClass {
    heuristic (node) {
      return Math.max(0, distanceToPoint({ x: node.x + 0.5, y: node.y, z: node.z + 0.5 }, position) - range)
    }

    isEnd (node) {
      return distanceToPoint({ x: node.x + 0.5, y: node.y, z: node.z + 0.5 }, position) <= range
    }
  })()
}

async function gotoPosition (ctx, position, range = 1) {
  const goal = makePointGoal(position, range)
  try {
    await ctx.wait(ctx.bot.pathfinder.goto(goal))
  } catch (err) {
    if (ctx.token.cancelled) throw err
    throw new ActionError('PATHFIND_FAILED', `Could not reach destination: ${err.message}`)
  }
  ctx.check()
  await ctx.sleep(200) // Let the final physics tick settle before measuring.
}

async function ensureNearBlock (ctx, block, interactionRange = 4.25) {
  ctx.check()
  if (!block) throw new ActionError('BLOCK_NOT_FOUND', 'Target block is not loaded')
  if (distanceToBlock(ctx.bot, block) <= interactionRange - 0.75) return
  await gotoPosition(ctx, block.position, 2)
  const distance = distanceToBlock(ctx.bot, block)
  if (distance > interactionRange) {
    throw new ActionError('OUT_OF_REACH', `Still too far from block (${distance.toFixed(2)} > ${interactionRange})`)
  }
}

function stopPathfinding (bot) {
  if (!bot || !bot.pathfinder) return
  try {
    bot.pathfinder.stop()
  } catch {
    // pathfinder may not be active
  }
  try {
    bot.pathfinder.setGoal(null)
  } catch {
    // ignore
  }
}

function candidateTool (bot, block) {
  const items = bot.inventory.items()
  const candidates = []
  if (block.canHarvest(null)) {
    const time = block.digTime(null, false, false, false)
    if (Number.isFinite(time)) candidates.push({ item: null, time })
  }
  for (const item of items) {
    if (!block.canHarvest(item.type)) continue
    const time = block.digTime(item.type, false, false, false)
    if (!Number.isFinite(time)) continue
    candidates.push({ item, time })
  }
  if (candidates.length === 0 && block.harvestTools) {
    throw new ActionError('MISSING_TOOL', `No suitable tool to harvest ${block.name}`)
  }
  candidates.sort((a, b) => a.time - b.time)
  return candidates.length > 0 ? candidates[0].item : null
}

async function equipForBlock (ctx, block) {
  const tool = candidateTool(ctx.bot, block)
  if (tool) {
    const held = ctx.bot.heldItem
    if (held && held.type === tool.type) return tool
    await ctx.wait(ctx.bot.equip(tool, 'hand'))
    ctx.check()
    return tool
  }
  if (ctx.bot.heldItem) {
    try {
      await ctx.wait(ctx.bot.unequip('hand'))
    } catch (err) {
      if (ctx.token.cancelled) throw err
      // Using the currently held item is still a valid survival interaction
      // when no tool is required for harvesting; do not fail the dig for this.
    }
  }
  return null
}

async function waitForBlockGone (ctx, block, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    ctx.check()
    const current = ctx.bot.blockAt(block.position)
    if (!current || current.type !== block.type) return current
    await ctx.sleep(100)
  }
  return null
}

async function digBlock (ctx, block) {
  ctx.check()
  const current = ctx.bot.blockAt(block.position)
  if (!current || current.type !== block.type) {
    throw new ActionError('BLOCK_CHANGED', 'Target block changed before mining')
  }
  if (!ctx.bot.canDigBlock(current)) {
    throw new ActionError('CANNOT_DIG', `Cannot dig ${current.name} here`)
  }
  if (distanceToBlock(ctx.bot, current) > 4.5) {
    throw new ActionError('OUT_OF_REACH', 'Target block is out of reach')
  }
  await equipForBlock(ctx, current)
  ctx.check()
  try {
    await ctx.wait(ctx.bot.dig(current, true))
  } catch (err) {
    if (ctx.token.cancelled) throw err
    throw new ActionError('DIG_FAILED', `Failed to mine ${current.name}: ${err.message}`)
  }
  const gone = await waitForBlockGone(ctx, current)
  if (!gone) {
    throw new ActionError('DIG_UNCONFIRMED', `Mining ${current.name} was not confirmed by a block update`)
  }
  return current
}

function findBlocks (bot, blockIds, radius, count) {
  if (!bot.entity) return []
  const positions = bot.findBlocks({
    matching: blockIds.length === 1 ? blockIds[0] : blockIds,
    maxDistance: radius,
    count
  })
  const blocks = []
  for (const position of positions) {
    const block = bot.blockAt(position)
    if (block) blocks.push(block)
  }
  return blocks
}

module.exports = {
  resolveItem,
  resolveBlock,
  blockName,
  blockCenter,
  distanceToPoint,
  distanceToBlock,
  configureMovements,
  gotoPosition,
  makePointGoal,
  ensureNearBlock,
  stopPathfinding,
  candidateTool,
  equipForBlock,
  digBlock,
  findBlocks,
  getPathfinder,
  getVec3
}
