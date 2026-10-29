'use strict'

const { ActionError } = require('../errors')
const { resolveItem, resolveBlock, ensureNearBlock, getVec3 } = require('../game')
const { inventoryCounts, countOf } = require('../inventory')

// One ordinary block per explicit action. This does not choose a location,
// acquire materials or silently place facilities during craft/navigation.
async function run (ctx, args) {
  const bot = ctx.bot
  const Vec3 = getVec3(bot)
  const target = new Vec3(args.position.x, args.position.y, args.position.z)
  const blockInfo = resolveBlock(bot, args.item)
  const itemInfo = resolveItem(bot, args.item)
  const item = bot.inventory.items().find(item => item.type === itemInfo.id)
  if (!item) throw new ActionError('MISSING_ITEM', 'No placement item in inventory')
  const initial = bot.blockAt(target)
  if (!initial) throw new ActionError('BLOCK_NOT_LOADED', 'Placement position is not loaded')
  if (!['air', 'cave_air', 'void_air'].includes(initial.name)) {
    throw new ActionError('TARGET_OCCUPIED', 'Placement target must be empty')
  }
  let support = bot.blockAt(target.offset(0, -1, 0))
  if (!support || support.boundingBox !== 'block') throw new ActionError('MISSING_SUPPORT', 'A solid block below is required')
  await ensureNearBlock(ctx, support)
  ctx.check()
  if (!['air', 'cave_air', 'void_air'].includes(bot.blockAt(target)?.name)) {
    throw new ActionError('TARGET_OCCUPIED', 'Placement target changed')
  }
  support = bot.blockAt(target.offset(0, -1, 0))
  const before = countOf(inventoryCounts(bot), args.item)
  await ctx.wait(bot.equip(item, 'hand'))
  ctx.check()
  if (bot.heldItem?.type !== itemInfo.id) throw new ActionError('EQUIP_UNCONFIRMED', 'Placement item not equipped')
  const sneaking = bot.getControlState('sneak')
  try {
    bot.setControlState('sneak', true)
    ctx.setEffect({ item: args.item, position: args.position, effect_unknown: true })
    await ctx.wait(bot.placeBlock(support, new Vec3(0, 1, 0)))
    for (let attempt = 0; attempt < 20; attempt++) {
      ctx.check()
      const placed = bot.blockAt(target)
      const consumed = before - countOf(inventoryCounts(bot), args.item)
      ctx.setEffect({ item: args.item, position: args.position, placed_block: placed?.name, consumed_count: consumed })
      if (placed?.type === blockInfo.id && consumed === 1) {
        ctx.markVerified({ placed_block: args.item, consumed_count: consumed, effect_unknown: false })
        return
      }
      await ctx.sleep(100)
    }
    throw new ActionError('PLACE_UNCONFIRMED', 'Placement and inventory consumption did not both confirm')
  } finally {
    bot.setControlState('sneak', ctx.token.cancelled ? false : sneaking)
  }
}

module.exports = { run }
