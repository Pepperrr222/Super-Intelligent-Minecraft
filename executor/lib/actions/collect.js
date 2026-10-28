'use strict'

const { ActionError } = require('../errors')
const { resolveBlock, findBlocks, ensureNearBlock, digBlock, distanceToPoint } = require('../game')
const { canonicalName, inventoryCounts, diffCounts } = require('../inventory')
const { pendingDropsNear, groundTarget, gainFor, createPickupSession, pickupDrops } = require('./collect-pickup')

const SEARCH_RADIUS = 32
const TERMINAL_ERRORS = new Set(['MISSING_TOOL', 'NOT_CONNECTED', 'EQUIP_UNCONFIRMED', 'DIG_UNCONFIRMED'])

function dropProfile (bot, blockInfo, blockName, count) {
  const expected = new Set()
  const identity = /_(log|wood|stem|hyphae)$/.test(blockName)
  if (identity) expected.add(blockName)
  else {
    for (const drop of blockInfo.drops || []) {
      const item = Number.isInteger(drop) && bot.registry.items && bot.registry.items[drop]
      if (item) expected.add(canonicalName(item.name))
    }
    const name = blockName.replace('minecraft:', '')
    if (bot.registry.itemsByName && bot.registry.itemsByName[name]) expected.add(blockName)
  }
  if (!expected.size) throw new ActionError('DROP_MAPPING_UNSUPPORTED', 'Cannot identify drops for ' + blockName)
  return { expected, wanted: identity ? count : 1, identity }
}

function requireSpace (bot, expected) {
  if (!bot.inventory.emptySlotCount || bot.inventory.emptySlotCount() > 0) return
  const canStack = bot.inventory.items().some(item => expected.has(canonicalName(item.name)) &&
    item.count < (item.stackSize || 64))
  if (!canStack) throw new ActionError('INVENTORY_FULL', 'No inventory space for the target drops')
}

function candidateKey (block) {
  return [block.position.x, block.position.y, block.position.z, block.stateId ?? block.type].join(',')
}

function selectCandidate (bot, candidates, origin, blockId, failed) {
  return candidates.map(candidate => bot.blockAt(candidate.position)).filter(block =>
    block && block.type === blockId && !failed.has(candidateKey(block)) &&
    distanceToPoint(origin, block.position) <= SEARCH_RADIUS)
    .sort((a, b) => {
      const score = block => distanceToPoint(bot.entity.position, block.position) + Math.max(0, block.position.y - bot.entity.position.y - 1) * 3
      return score(a) - score(b) || a.position.x - b.position.x || a.position.y - b.position.y || a.position.z - b.position.z
    })[0] || null
}

async function run (ctx, args) {
  const bot = ctx.bot
  if (!bot.entity) throw new ActionError('NOT_CONNECTED', 'Bot is not spawned')
  const blockInfo = resolveBlock(bot, args.block)
  const profile = dropProfile(bot, blockInfo, args.block, args.count)
  const before = inventoryCounts(bot)
  const origin = { ...bot.entity.position }
  const positions = []
  const failed = new Set()
  const failures = []
  const pickup = createPickupSession()
  let mined = 0
  let attempts = 0
  let lastError = null
  const maxAttempts = Math.min(128, Math.max(12, args.count * 3))
  ctx.setEffect({ block: args.block, requested_count: args.count, mined_count: 0,
    confirmed_mined_count: 0, inventory_delta: {}, phase: 'precheck', action_origin: origin,
    target_items: [...profile.expected], target_required_gain: profile.wanted })
  try {
    requireSpace(bot, profile.expected)
    while (mined < args.count && attempts < maxAttempts) {
      ctx.check()
      requireSpace(bot, profile.expected)
      ctx.setEffect({ phase: 'search', candidate_attempts: attempts })
      const candidates = findBlocks(bot, [blockInfo.id], SEARCH_RADIUS, 128)
      const target = selectCandidate(bot, candidates, origin, blockInfo.id, failed)
      if (!target) {
        lastError = new ActionError('BLOCK_NOT_FOUND', 'No untried ' + args.block + ' within the action origin radius')
        break
      }
      attempts++
      const key = candidateKey(target)
      try {
        ctx.setEffect({ phase: 'navigate', target_position: { ...target.position }, candidate_attempts: attempts })
        await ensureNearBlock(ctx, target)
        const fresh = bot.blockAt(target.position)
        if (!fresh || fresh.type !== blockInfo.id) {
          failed.add(key)
          lastError = new ActionError('BLOCK_CHANGED', 'Candidate changed or unloaded before digging')
          failures.push({ position: { ...target.position }, code: 'BLOCK_CHANGED', at: Date.now() })
          ctx.setEffect({ failed_candidates: failures.slice(-16) })
          continue
        }
        await digBlock(ctx, fresh)
        mined++
        positions.push({ ...fresh.position })
        ctx.setEffect({ mined_count: mined, confirmed_mined_count: mined })
      } catch (err) {
        if (ctx.token.cancelled) throw err
        lastError = err
        if (TERMINAL_ERRORS.has(err.code)) throw err
        failed.add(key)
        failures.push({ position: { ...target.position }, code: err.code || 'ACTION_FAILED', at: Date.now() })
        ctx.setEffect({ failed_candidates: failures.slice(-16) })
        continue
      }
      // Pickup while still near the trunk. All rounds share a single budget/exclusion set.
      const wanted = profile.identity ? mined : 1
      await pickupDrops(ctx, before, positions, profile.expected, wanted, pickup, { maxMs: 2000, requireClear: !profile.identity })
    }
    const picked = positions.length
      ? await pickupDrops(ctx, before, positions, profile.expected, profile.wanted, pickup, { requireClear: !profile.identity })
      : { gained_count: 0, pending_drops: 0, pickup_ms: 0 }
    ctx.setEffect({ phase: 'verify', gained_count: picked.gained_count, pending_drops: picked.pending_drops })
    if (mined < args.count) {
      throw new ActionError('COLLECT_INCOMPLETE', 'Confirmed mining ' + mined + '/' + args.count +
        '; gained ' + picked.gained_count + ' target items' + (lastError ? ': ' + lastError.message : ''))
    }
    if (picked.gained_count < profile.wanted || (!profile.identity && picked.pending_drops > 0)) {
      ctx.setEffect({ phase: 'pickup' })
      throw new ActionError('DROPS_NOT_PICKED_UP', 'Confirmed mining ' + mined + '/' + args.count +
        '; gained ' + picked.gained_count + '/' + profile.wanted + ' target items; pickup route/budget exhausted')
    }
    ctx.markVerified({ phase: 'completed' })
  } finally {
    ctx.setEffect({ mined_count: mined, confirmed_mined_count: mined,
      inventory_delta: diffCounts(before, inventoryCounts(bot)),
      gained_count: gainFor(before, inventoryCounts(bot), profile.expected),
      failed_candidates: failures.slice(-16), pickup_diagnostics: pickup.diagnostics.slice(),
      drop_pickup_ms: pickup.elapsed, pending_drops: pendingDropsNear(bot, positions, profile.expected).length })
  }
}

// Retained for compatibility with older diagnostic tests; completion uses target-specific gainFor.
function hasPositiveDelta (delta) { return Object.values(delta).some(value => value > 0) }
module.exports = { run, pendingDropsNear, groundTarget, hasPositiveDelta, dropProfile, requireSpace, candidateKey, selectCandidate }
