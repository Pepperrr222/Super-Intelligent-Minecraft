'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { run: craft } = require('../lib/actions/craft')
const { run: place } = require('../lib/actions/place')
const { validateArgs } = require('../lib/validation')

function context (bot) {
  return { bot, token: { cancelled: false }, effect: {}, verified: false,
    check () {}, wait: async promise => await promise, sleep: async () => {},
    setEffect (patch) { Object.assign(this.effect, patch) },
    markVerified (patch) { this.verified = true; Object.assign(this.effect, patch) } }
}

test('multi-batch crafting reconciles each real batch instead of trusting speculative output', async () => {
  let produced = 0
  let pending = 0
  const calls = []
  const recipe = { requiresTable: false, result: { id: 5, count: 4 } }
  const bot = { entity: {}, currentWindow: null,
    registry: { itemsByName: { oak_planks: { id: 5 } }, blocksByName: { crafting_table: { id: 10 } } },
    inventory: { slots: [], selectedItem: null, items: () => produced ? [{ name: 'oak_planks', count: produced }] : [] },
    findBlocks: () => [], recipesFor: () => [recipe], recipesAll: () => [recipe],
    craft: async (recipe, count) => { calls.push(count); pending = produced + 4 },
    _syncWindow: async () => { produced = pending }
  }
  const ctx = context(bot)
  await craft(ctx, { item: 'minecraft:oak_planks', count: 8 })
  assert.deepEqual(calls, [1, 1])
  assert.equal(ctx.effect.produced_count, 8)
  assert.equal(ctx.verified, true)
})

class Vec {
  constructor (x, y, z) { Object.assign(this, { x, y, z }) }
  offset (x, y, z) { return new Vec(this.x + x, this.y + y, this.z + z) }
}
function placementBot () {
  let placed = false
  let count = 2
  const item = { type: 1, name: 'crafting_table', count: 2 }
  return { entity: { position: new Vec(0.5, 0, 0.5) },
    registry: { itemsByName: { crafting_table: { id: 1 } }, blocksByName: { crafting_table: { id: 1 } } },
    inventory: { items: () => [{ ...item, count }] },
    blockAt: at => at.y === -1 ? { position: at, name: 'stone', type: 2, boundingBox: 'block' }
      : { position: at, name: placed ? 'crafting_table' : 'air', type: placed ? 1 : 0 },
    equip: async function () { this.heldItem = item }, getControlState: () => false, setControlState () {},
    placeBlock: async () => { placed = true; count-- }
  }
}
test('placement verifies the block and one consumed inventory item', async () => {
  const ctx = context(placementBot())
  await place(ctx, { item: 'minecraft:crafting_table', position: { x: 2, y: 0, z: 0 } })
  assert.equal(ctx.effect.consumed_count, 1)
  assert.equal(ctx.effect.effect_unknown, false)
  assert.equal(ctx.verified, true)
})
test('placement does not overwrite an occupied block', async () => {
  const bot = placementBot()
  bot.blockAt = at => ({ position: at, name: 'stone', type: 2, boundingBox: 'block' })
  await assert.rejects(place(context(bot), { item: 'minecraft:crafting_table', position: { x: 2, y: 0, z: 0 } }), error => error.code === 'TARGET_OCCUPIED')
})
test('placement accepts only an explicit integer target', () => {
  const request = { kind: 'place', item: 'minecraft:crafting_table', position: { x: 2, y: 0, z: 0 } }
  assert.deepEqual(validateArgs('act', request), request)
  assert.throws(() => validateArgs('act', { ...request, position: { x: 2.5, y: 0, z: 0 } }))
})
