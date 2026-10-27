'use strict'

const { ActionError } = require('../errors')
const { gotoPosition, distanceToPoint } = require('../game')
const { round } = require('../observation')

async function run (ctx, args) {
  ctx.check()
  if (!ctx.bot.entity) throw new ActionError('NOT_CONNECTED', 'Bot is not spawned')
  const before = {
    x: round(ctx.bot.entity.position.x),
    y: round(ctx.bot.entity.position.y),
    z: round(ctx.bot.entity.position.z)
  }
  await gotoPosition(ctx, args.position, args.range)
  const afterPosition = ctx.bot.entity.position
  const distance = distanceToPoint(afterPosition, args.position)
  const effect = {
    target: args.position,
    range: args.range,
    position_before: before,
    position_after: {
      x: round(afterPosition.x),
      y: round(afterPosition.y),
      z: round(afterPosition.z)
    },
    distance_to_target: round(distance)
  }
  ctx.setEffect(effect)
  if (distance > args.range + 0.75) {
    throw new ActionError('GOTO_INCOMPLETE', `Stopped ${distance.toFixed(2)} blocks from target (range ${args.range})`)
  }
  ctx.markVerified(effect)
}

module.exports = { run }
