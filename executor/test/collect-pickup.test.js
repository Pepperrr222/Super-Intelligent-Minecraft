'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { CancellationToken } = require('../lib/cancellation')
const pickup = require('../lib/actions/collect-pickup')
const collect = require('../lib/actions/collect')
const { waitForBlockGone, equipForBlock, makePointGoal } = require('../lib/game')

function fixture (t, options = {}) {
  let clock = 0
  t.mock.method(Date, 'now', () => clock)
  const counts = new Map()
  const effect = {}
  const token = new CancellationToken()
  const bot = {
    game: { minY: 0 },
    entity: { position: new Vec3(0.5, 64, 0.5) }, entities: {}, heldItem: null,
    inventory: { items: () => [...counts].map(([name, count]) => ({ name, count, stackSize: 64 })), emptySlotCount: () => 30 },
    blockAt (p) {
      if (options.unloaded) return null
      if (p.y === 63 || (options.canopy && p.y === 69)) return { type: 1, boundingBox: 'block', name: 'leaves' }
      return { type: 0, boundingBox: 'empty', name: 'air' }
    }
  }
  const ctx = { bot, token, check: () => token.check(), wait: p => token.wait(p),
    sleep: async ms => { token.check(); clock += ms; token.check() },
    setEffect: patch => Object.assign(effect, patch), markVerified: patch => { Object.assign(effect, patch); ctx.verified = true } }
  const drop = (id, x, y = 64.1, name = 'oak_log') => {
    bot.entities[id] = { id, name: 'item', position: new Vec3(x, y, 0.5), getDroppedItem: () => ({ name }) }
    return bot.entities[id]
  }
  return { ctx, bot, counts, effect, token, drop, now: () => clock }
}

test('known unrelated drops are filtered; unknown metadata is kept unknown', t => {
  const f = fixture(t)
  f.drop(1, 1.5, 64.1, 'dirt'); f.drop(2, 2.5)
  f.bot.entities[3] = { id: 3, name: 'item', position: new Vec3(2.5, 64, 0.5), getDroppedItem () { throw Error('not ready') } }
  assert.deepEqual(pickup.pendingDropsNear(f.bot, [{ x: 1, y: 64, z: 0 }], new Set(['minecraft:oak_log'])).map(e => e.id), [2, 3])
  assert.equal(pickup.droppedName(f.bot.entities[3]), null)
  assert.equal(pickup.gainFor(new Map(), new Map([['minecraft:dirt', 4]]), new Set(['minecraft:oak_log'])), 0)
})

test('standable approaches distinguish canopy, lower ground, obstruction and unloaded cells', t => {
  const f = fixture(t, { canopy: true })
  assert.ok(pickup.pickupPositions(f.bot, new Vec3(2.5, 70.1, 0.5)).some(p => p.y === 70))
  assert.ok(pickup.pickupPositions(f.bot, new Vec3(2.5, 64.1, 0.5)).every(p => p.y === 64))
  f.bot.blockAt = () => null
  assert.deepEqual(pickup.pickupPositions(f.bot, new Vec3(2.5, 70, 0.5)), [])
  assert.equal(pickup.groundTarget(f.bot, { x: 2, y: 70, z: 0 }), null)
})

test('falling entity invalidates old path and next approach uses its live lower position', async t => {
  const f = fixture(t, { canopy: true })
  f.bot.entity.position.y = 70
  const item = f.drop(1, 2.5, 70.1)
  const ys = []
  const result = await pickup.pickupDrops(f.ctx, new Map(), [{ x: 2, y: 70, z: 0 }], new Set(['minecraft:oak_log']), 1,
    pickup.createPickupSession(), { now: f.now, navigate: async (ctx, point, range, options) => {
      ys.push(point.y)
      if (ys.length === 1) { item.position.y = 64.1; assert.equal(options.isObsolete(), true) } else {
        f.counts.set('oak_log', 1); delete f.bot.entities[1]
      }
    } })
  assert.deepEqual(ys, [70, 64])
  assert.equal(result.gained_count, 1)
})

test('failed item approaches are excluded; a reachable second item can satisfy the target', async t => {
  const f = fixture(t)
  f.drop(1, 1.5); f.drop(2, 4.5)
  const goals = []
  const session = pickup.createPickupSession()
  const result = await pickup.pickupDrops(f.ctx, new Map(), [{ x: 1, y: 64, z: 0 }, { x: 4, y: 64, z: 0 }],
    new Set(['minecraft:oak_log']), 1, session, { now: f.now, navigate: async (ctx, p) => {
      goals.push(JSON.stringify(p))
      if (p.x < 3) throw Error('unreachable')
      f.counts.set('oak_log', 1); delete f.bot.entities[2]
    } })
  assert.equal(result.gained_count, 1)
  assert.equal(result.pending_drops, 1, 'leftover entity does not invalidate a satisfied inventory target')
  assert.equal(new Set(goals).size, goals.length)
  assert.ok(session.diagnostics.some(d => d.result === 'PATHFIND_FAILED'))
})

test('partial target gain does not stop before the requested gain; old stock does not count', async t => {
  const f = fixture(t)
  f.counts.set('oak_log', 10); f.drop(1, 2.5); f.drop(2, 5.5)
  let navigations = 0
  const result = await pickup.pickupDrops(f.ctx, new Map([['minecraft:oak_log', 10]]), [{ x: 2, y: 64, z: 0 }, { x: 5, y: 64, z: 0 }],
    new Set(['minecraft:oak_log']), 2, pickup.createPickupSession(), { now: f.now, navigate: async () => {
      f.counts.set('oak_log', 11 + navigations); delete f.bot.entities[++navigations]
    } })
  assert.equal(result.gained_count, 2)
  assert.equal(navigations, 2)
})

test('unreachable drops end within budget without manufacturing inventory gain', async t => {
  const f = fixture(t, { unloaded: true }); f.drop(1, 2.5)
  const session = pickup.createPickupSession()
  const result = await pickup.pickupDrops(f.ctx, new Map(), [{ x: 2, y: 64, z: 0 }], new Set(['minecraft:oak_log']), 1,
    session, { now: f.now, maxMs: 1000, navigate: async () => assert.fail('no standable goal') })
  assert.equal(result.gained_count, 0)
  assert.ok(f.now() <= 1250)
  assert.ok(session.diagnostics.some(d => d.result === 'NO_STANDABLE_APPROACH'))
})

test('stop after approach prevents a second pickup navigation', async t => {
  const f = fixture(t); f.drop(1, 2.5); let calls = 0
  await assert.rejects(pickup.pickupDrops(f.ctx, new Map(), [{ x: 2, y: 64, z: 0 }], new Set(['minecraft:oak_log']), 1,
    pickup.createPickupSession(), { now: f.now, navigate: async () => { calls++; f.token.cancel('stop') } }),
  e => e.code === 'ACTION_CANCELLED')
  assert.equal(calls, 1)
  assert.equal(f.effect.gained_count, 0)
})

test('block confirmation distinguishes changed, unloaded and timed out', async t => {
  const f = fixture(t)
  const block = { type: 2, position: new Vec3(1, 64, 0) }
  assert.equal((await waitForBlockGone(f.ctx, block)).status, 'confirmed_changed')
  f.bot.blockAt = () => null
  assert.equal((await waitForBlockGone(f.ctx, block)).status, 'unknown')
  f.bot.blockAt = () => block
  assert.equal((await waitForBlockGone(f.ctx, block, 300)).status, 'timed_out')
})

test('equip acknowledgement without actual held tool is rejected', async t => {
  const f = fixture(t)
  f.bot.heldItem = { type: 2, name: 'stick' }
  f.bot.inventory.items = () => [{ type: 1, name: 'iron_axe' }]
  f.bot.equip = async () => {}
  await assert.rejects(equipForBlock(f.ctx, { name: 'oak_log', canHarvest: type => type === 1, digTime: () => 100 }),
    e => e.code === 'EQUIP_UNCONFIRMED')
})

test('candidate failure excludes only the unchanged target; origin radius prevents roaming', t => {
  const f = fixture(t)
  const a = { type: 2, stateId: 20, position: new Vec3(1, 64, 0) }
  const b = { type: 2, stateId: 20, position: new Vec3(2, 64, 0) }
  const far = { type: 2, position: new Vec3(40, 64, 0) }
  f.bot.blockAt = p => [a, b, far].find(q => q.position.equals(p))
  const failed = new Set([collect.candidateKey(a)])
  assert.equal(collect.selectCandidate(f.bot, [a, b, far], new Vec3(0, 64, 0), 2, failed), b)
  a.stateId = 21
  assert.equal(collect.selectCandidate(f.bot, [a, b], new Vec3(0, 64, 0), 2, failed), a)
})

test('full inventory requires room for the actual target, not an unrelated partial stack', t => {
  const f = fixture(t); f.bot.inventory.emptySlotCount = () => 0
  f.counts.set('dirt', 1)
  assert.throws(() => collect.requireSpace(f.bot, new Set(['minecraft:oak_log'])), e => e.code === 'INVENTORY_FULL')
  f.counts.set('oak_log', 1)
  assert.doesNotThrow(() => collect.requireSpace(f.bot, new Set(['minecraft:oak_log'])))
})

test('ordinary point goals are unchanged; obsolete pickup goals return for observation', () => {
  let stale = false
  const goal = makePointGoal({ x: 10.5, y: 64, z: 0.5 }, 0.45, class {}, () => stale)
  assert.equal(goal.isEnd({ x: 0, y: 64, z: 0 }), false)
  stale = true
  assert.equal(goal.isEnd({ x: 0, y: 64, z: 0 }), true)
})

function collectingFixture (t, options = {}) {
  const f = fixture(t)
  const baseBlockAt = f.bot.blockAt.bind(f.bot)
  const blocks = new Map()
  for (const x of [4, 5]) {
    const block = { type: 2, stateId: 2, name: 'oak_log', boundingBox: 'block', position: new Vec3(x, 64, 0),
      canHarvest: () => true, digTime: tool => tool === null ? 100 : 300 }
    blocks.set(x, block)
  }
  f.bot.registry = { blocksByName: { oak_log: { id: 2, drops: [5] } }, itemsByName: { oak_log: { id: 5, name: 'oak_log' } }, items: { 5: { name: 'oak_log' } } }
  let unloadedX = null
  f.bot.blockAt = p => unloadedX === p.x ? null : (p.y === 64 && p.z === 0 && blocks.get(p.x)) || baseBlockAt(p)
  f.bot.findBlocks = () => [...blocks.values()].map(b => b.position)
  f.bot.canDigBlock = block => !(options.firstBlocked && block.position.x === 4)
  f.bot.dig = async block => {
    blocks.delete(block.position.x)
    if (options.unconfirmed) { unloadedX = block.position.x; return }
    f.drop(block.position.x, block.position.x + 0.5, 64.1, options.unrelated ? 'dirt' : 'oak_log')
  }
  f.bot.pathfinder = { goto: async goal => {
    let target = null
    for (let x = -1; x <= 8 && !target; x++) {
      for (let z = -2; z <= 2; z++) if (goal.isEnd({ x, y: 64, z })) { target = new Vec3(x + 0.5, 64, z + 0.5); break }
    }
    if (!target) throw Error('no path')
    f.bot.entity.position = target
    for (const entity of Object.values(f.bot.entities)) {
      if (target.distanceTo(entity.position) <= 1.5) {
        const name = entity.getDroppedItem().name
        f.counts.set(name, (f.counts.get(name) || 0) + 1)
        delete f.bot.entities[entity.id]
      }
    }
  } }
  return f
}

test('complete collect action interleaves pickup and verifies exact target gains', async t => {
  const f = collectingFixture(t)
  const phases = []
  const update = f.ctx.setEffect
  f.ctx.setEffect = patch => { update(patch); if (patch.phase) phases.push(patch.phase) }
  await collect.run(f.ctx, { block: 'minecraft:oak_log', count: 2 })
  assert.equal(f.ctx.verified, true)
  assert.equal(f.effect.confirmed_mined_count, 2)
  assert.equal(f.effect.gained_count, 2)
  assert.equal(f.effect.phase, 'completed')
  assert.ok(phases.indexOf('pickup') < phases.lastIndexOf('search'))
})

test('candidate-level cannot-dig skips to the next block rather than ending the action', async t => {
  const f = collectingFixture(t, { firstBlocked: true })
  await collect.run(f.ctx, { block: 'minecraft:oak_log', count: 1 })
  assert.equal(f.ctx.verified, true)
  assert.equal(f.effect.confirmed_mined_count, 1)
  assert.equal(f.effect.failed_candidates[0].code, 'CANNOT_DIG')
  assert.equal(f.effect.failed_candidates[0].position.x, 4)
})

test('unrelated pickup cannot turn a fully mined action into verified target collection', async t => {
  const f = collectingFixture(t, { unrelated: true })
  await assert.rejects(collect.run(f.ctx, { block: 'minecraft:oak_log', count: 1 }), e => e.code === 'DROPS_NOT_PICKED_UP')
  assert.equal(f.effect.mined_count, 1)
  assert.equal(f.effect.gained_count, 0)
  assert.notEqual(f.ctx.verified, true)
})

test('unloaded confirmation after digging is unknown and never counted or retried', async t => {
  const f = collectingFixture(t, { unconfirmed: true })
  await assert.rejects(collect.run(f.ctx, { block: 'minecraft:oak_log', count: 2 }), e => e.code === 'DIG_UNCONFIRMED')
  assert.equal(f.effect.effect_unknown, true)
  assert.equal(f.effect.confirmed_mined_count, 0)
  assert.equal(f.effect.candidate_attempts, 1)
})

test('generic block drops use registry mapping rather than assuming block name equals item', () => {
  const data = require('minecraft-data')('1.21.1')
  const profile = collect.dropProfile({ registry: data }, data.blocksByName.stone, 'minecraft:stone', 4)
  assert.equal(profile.identity, false)
  assert.ok(profile.expected.has('minecraft:cobblestone'))
  assert.equal(profile.wanted, 1, 'block count does not imply a universal item/drop ratio')
})

test('generic pickup still approaches remaining target entities after an earlier positive gain', async t => {
  const f = fixture(t)
  f.counts.set('oak_log', 1); f.drop(1, 2.5)
  let calls = 0
  const result = await pickup.pickupDrops(f.ctx, new Map(), [{ x: 2, y: 64, z: 0 }], new Set(['minecraft:oak_log']), 1,
    pickup.createPickupSession(), { requireClear: true, now: f.now, navigate: async () => {
      calls++; f.counts.set('oak_log', 2); delete f.bot.entities[1]
    } })
  assert.equal(calls, 1)
  assert.equal(result.gained_count, 2)
  assert.equal(result.pending_drops, 0)
})
