'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  CHEST_WINDOW_TYPES,
  FURNACE_WINDOW_TYPES,
  windowInventoryCounts
} = require('../lib/containers')
const { configureMovements } = require('../lib/game')
const { verifyFuelInsertion } = require('../lib/actions/smelt')

test('1.21.1 chest/barrel windows are accepted as generic_9x3/9x6', () => {
  assert.ok(CHEST_WINDOW_TYPES.has('minecraft:generic_9x3'))
  assert.ok(CHEST_WINDOW_TYPES.has('minecraft:generic_9x6'))
  assert.ok(CHEST_WINDOW_TYPES.has('minecraft:barrel'))
  assert.ok(CHEST_WINDOW_TYPES.has('minecraft:chest'))
  assert.ok(FURNACE_WINDOW_TYPES.has('minecraft:furnace'))
})

test('pathfinder movements never dig, tower, free-move or scaffold', () => {
  class FakeMovements {
    constructor (bot) {
      this.bot = bot
      this.canDig = true
      this.allow1by1towers = true
      this.allowFreeMotion = true
      this.scafoldingBlocks = [1, 2]
    }
  }
  const bot = {
    pathfinder: {
      movements: null,
      setMovements (movements) { this.movements = movements }
    }
  }
  const movements = configureMovements(bot, FakeMovements)
  assert.equal(movements.canDig, false)
  assert.equal(movements.allow1by1towers, false)
  assert.equal(movements.allowFreeMotion, false)
  assert.deepEqual(movements.scafoldingBlocks, [])
  assert.equal(bot.pathfinder.movements, movements)
  assert.equal(bot.pathfinder.thinkTimeout, 5000)
  assert.equal(bot.pathfinder.tickTimeout, 40)
})

test('fuel insertion is proven by inventory decrease even when the slot is already empty', () => {
  // One coal was consumed into the burn timer immediately: fuel slot is empty
  // but the player inventory went from 5 coal to 4.
  assert.deepEqual(verifyFuelInsertion(5, 4, 1, 0), {
    fuel_removed: 1,
    fuel_slot_count: 0
  })
  assert.throws(() => verifyFuelInsertion(5, 5, 1, 1), (err) => err.code === 'SMELT_FUEL_NOT_INSERTED')
  assert.throws(() => verifyFuelInsertion(5, 3, 1, 0), (err) => err.code === 'SMELT_FUEL_NOT_INSERTED')
})

test('live player inventory is read from the open window slots', () => {
  const window = {
    inventoryStart: 3,
    inventoryEnd: 6,
    slots: [
      { name: 'coal', count: 1 }, // furnace fuel slot, not player inventory
      { name: 'raw_iron', count: 2 }, // furnace input slot
      null,
      { name: 'dirt', count: 3 },
      { name: 'dirt', count: 2 },
      { name: 'bread', count: 4 }
    ]
  }
  const counts = windowInventoryCounts(window)
  assert.equal(counts.get('minecraft:dirt'), 5)
  assert.equal(counts.get('minecraft:bread'), 4)
  assert.equal(counts.get('minecraft:coal'), undefined)
})

test('drop detection only counts item entities near mined positions', () => {
  const { pendingDropsNear } = require('../lib/actions/collect')
  const bot = {
    entities: {
      1: { id: 1, name: 'item', position: { x: 1.5, y: -60, z: 4.5 } },
      2: { id: 2, name: 'item', position: { x: 40, y: -60, z: 4.5 } },
      3: { id: 3, name: 'zombie', position: { x: 1.5, y: -60, z: 4.5 } }
    }
  }
  const pending = pendingDropsNear(bot, [{ x: 1, y: -60, z: 4 }])
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, 1)
})

test('collect success requires a positive inventory delta', () => {
  const { hasPositiveDelta } = require('../lib/actions/collect')
  assert.equal(hasPositiveDelta({}), false)
  assert.equal(hasPositiveDelta({ 'minecraft:oak_log': 0, 'minecraft:dirt': -1 }), false)
  assert.equal(hasPositiveDelta({ 'minecraft:oak_log': 2 }), true)
})

test('ground sweep target is the walkable block below a mined (now air) block', () => {
  const { groundTarget } = require('../lib/actions/collect')
  const bot = {
    game: { minY: -64 },
    blockAt: (position) => {
      if (position.y === -61) return { boundingBox: 'block', name: 'stone' }
      return { boundingBox: 'empty', name: 'air' }
    }
  }
  assert.deepEqual(groundTarget(bot, { x: 3, y: -59, z: 3 }), { x: 3.5, y: -60, z: 3.5 })
})

function craftRecoveryContext (bot) {
  return {
    bot,
    token: { cancelled: false, check () {}, wait: async (promise) => await promise },
    wait: async (promise) => await promise,
    sleep: async () => {},
    check () {},
    setEffect () {}
  }
}

test('craft recovery puts a result left on the cursor back into inventory', async () => {
  const { recoverCraftingState } = require('../lib/actions/craft')
  const slots = new Array(12).fill(null)
  slots[9] = { type: 36, name: 'oak_planks', metadata: null, count: 2 }
  const inventory = {
    inventoryStart: 9,
    inventoryEnd: 12,
    slots,
    selectedItem: { type: 36, name: 'oak_planks', metadata: null, count: 4 },
    findItemRange (start, end, type, metadata, notFull) {
      for (let i = start; i < end; i++) {
        const item = this.slots[i]
        if (item && item.type === type && (!notFull || item.count < 64)) return item
      }
      return null
    },
    emptySlotCount () { return 0 }
  }
  const bot = {
    currentWindow: null,
    inventory,
    _syncWindow: async () => {},
    putSelectedItemRange: async (start, end, window) => {
      window.slots[9].count += window.selectedItem.count
      window.selectedItem = null
    }
  }
  const recovery = await recoverCraftingState(craftRecoveryContext(bot))
  assert.equal(recovery.cursor_recovered, true)
  assert.equal(inventory.selectedItem, null)
  assert.equal(inventory.slots[9].count, 6)
})

test('craft recovery puts a result left in the output slot into inventory', async () => {
  const { recoverCraftingState } = require('../lib/actions/craft')
  const slots = new Array(12).fill(null)
  slots[0] = { type: 36, name: 'oak_planks', metadata: null, count: 4 }
  slots[9] = { type: 36, name: 'oak_planks', metadata: null, count: 2 }
  const inventory = {
    inventoryStart: 9,
    inventoryEnd: 12,
    slots,
    selectedItem: null,
    findItemRange (start, end, type, metadata, notFull) {
      for (let i = start; i < end; i++) {
        const item = this.slots[i]
        if (item && item.type === type && (!notFull || item.count < 64)) return item
      }
      return null
    },
    emptySlotCount () { return 0 }
  }
  const bot = {
    currentWindow: null,
    inventory,
    _syncWindow: async () => {},
    putAway: async (slot) => {
      inventory.slots[9].count += inventory.slots[slot].count
      inventory.slots[slot] = null
    }
  }
  const recovery = await recoverCraftingState(craftRecoveryContext(bot))
  assert.equal(recovery.output_recovered, true)
  assert.equal(inventory.slots[0], null)
  assert.equal(inventory.slots[9].count, 6)
})
