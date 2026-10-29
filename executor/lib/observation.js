'use strict'

const { canonicalName, inventoryList } = require('./inventory')
const { windowInventoryList } = require('./containers')

const CAPABILITIES = Object.freeze([
  'observe',
  'find_blocks',
  'inspect_container',
  'recipes',
  'act',
  'action_status',
  'stop',
  'say',
  'shutdown',
  'goto',
  'follow',
  'collect',
  'craft',
  'place',
  'deposit',
  'withdraw',
  'smelt'
])

function nowIso () {
  return new Date().toISOString()
}

function round (value, digits = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function vec (position) {
  if (!position) return null
  return { x: round(position.x), y: round(position.y), z: round(position.z) }
}

function dimensionName (bot) {
  const raw = bot && bot.game && bot.game.dimension
  return canonicalName(raw || 'overworld') || 'minecraft:overworld'
}

function makeWorldId (label, bot) {
  return `${label}@${dimensionName(bot)}`
}

function nearbyPlayers (bot, range = 64) {
  if (!bot || !bot.players || !bot.entity) return []
  const origin = bot.entity.position
  const players = []
  for (const [username, player] of Object.entries(bot.players)) {
    if (!player || !player.entity || username === bot.username) continue
    const position = player.entity.position
    if (!position || origin.distanceTo(position) > range) continue
    players.push({ name: username, position: vec(position) })
  }
  players.sort((a, b) => a.name.localeCompare(b.name))
  return players.slice(0, 32)
}

function snapshotState (bot, worldId, connectedOverride) {
  const connected = connectedOverride === undefined
    ? Boolean(bot && bot.entity && bot.entity.position)
    : Boolean(connectedOverride)
  return {
    connected,
    world_id: worldId,
    observed_at: nowIso(),
    username: bot && bot.username ? bot.username : null,
    position: bot && bot.entity ? vec(bot.entity.position) : null,
    health: bot && typeof bot.health === 'number' ? bot.health : null,
    food: bot && typeof bot.food === 'number' ? bot.food : null,
    dimension: dimensionName(bot),
    // bot.inventory is only copied back when a container closes.  While a
    // window is open, read the live player-inventory slots from that window.
    inventory: bot && bot.currentWindow
      ? windowInventoryList(bot.currentWindow)
      : inventoryList(bot)
  }
}

function observe (bot, worldId, connectedOverride) {
  const state = snapshotState(bot, worldId, connectedOverride)
  return {
    ...state,
    nearby_players: nearbyPlayers(bot),
    capabilities: [...CAPABILITIES]
  }
}

module.exports = {
  CAPABILITIES,
  nowIso,
  round,
  dimensionName,
  makeWorldId,
  snapshotState,
  observe
}
