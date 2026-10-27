'use strict'

const { ActionError } = require('../errors')
const { getPathfinder, stopPathfinding, distanceToPoint } = require('../game')
const { round } = require('../observation')

function playerEntity (bot, username) {
  const player = bot.players && bot.players[username]
  return player && player.entity ? player.entity : null
}

async function run (ctx, args) {
  ctx.check()
  const bot = ctx.bot
  if (!bot.entity) throw new ActionError('NOT_CONNECTED', 'Bot is not spawned')
  let target = playerEntity(bot, args.player)
  if (!target) {
    throw new ActionError('PLAYER_NOT_FOUND', `Player ${args.player} is not visible`)
  }

  const { goals } = getPathfinder()
  const startedAt = Date.now()
  const durationMs = args.duration_seconds * 1000
  let followedMs = 0
  try {
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
    while (true) {
      ctx.check()
      const elapsed = Date.now() - startedAt
      if (elapsed >= durationMs) break
      target = playerEntity(bot, args.player)
      if (!target) {
        ctx.setEffect({ followed_seconds: round(followedMs / 1000), distance: null })
        throw new ActionError('PLAYER_LOST', `Player ${args.player} left before the follow duration finished`)
      }
      followedMs = elapsed
      await ctx.sleep(Math.min(250, durationMs - elapsed))
    }
    stopPathfinding(bot)
    ctx.check()
    target = playerEntity(bot, args.player)
    const current = bot.entity.position
    const distance = target ? distanceToPoint(current, target.position) : null
    const effect = {
      player: args.player,
      duration_seconds: args.duration_seconds,
      followed_seconds: round(Math.min(durationMs, Date.now() - startedAt) / 1000),
      distance: distance === null ? null : round(distance),
      success_reason: 'finite_follow_duration_elapsed'
    }
    ctx.setEffect(effect)
    if (distance === null) throw new ActionError('PLAYER_LOST', 'Follow target is no longer visible')
    if (distance > 3) throw new ActionError('FOLLOW_INCOMPLETE', `Follow ended ${distance.toFixed(2)} blocks from the target`)
    ctx.markVerified(effect)
  } finally {
    stopPathfinding(bot)
  }
}

module.exports = { run }
