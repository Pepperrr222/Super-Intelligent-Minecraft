'use strict'

const { ActionError } = require('../errors')
const { resolveItem } = require('../game')
const { canonicalName, countOf, deltaFor } = require('../inventory')
const {
  openFurnaceAt,
  moveIntoSlot,
  takeFromSlot,
  windowInventoryCounts,
  windowInventoryList
} = require('../containers')

const INPUT_SLOT = 0
const FUEL_SLOT = 1
const OUTPUT_SLOT = 2

function slotItem (window, slot) {
  return window.slots[slot] || null
}

function fuelSlotCount (window, itemType) {
  const item = slotItem(window, FUEL_SLOT)
  return item && item.type === itemType ? item.count : 0
}

function burnObserved (window) {
  const seconds = window.fuelSeconds
  if (typeof seconds === 'number' && seconds > 0) return true
  const fuel = slotItem(window, FUEL_SLOT)
  return Boolean(fuel && fuel.count > 0)
}

/**
 * Fuel can be consumed into the burn timer immediately, leaving the fuel slot
 * empty.  The player's inventory decrease is therefore the insertion proof.
 */
function verifyFuelInsertion (beforeCount, afterCount, requested, fuelSlotCount) {
  const removed = beforeCount - afterCount
  if (removed !== requested) {
    throw new ActionError('SMELT_FUEL_NOT_INSERTED',
      `Player inventory fuel decreased by ${removed}, expected ${requested}`)
  }
  return { fuel_removed: removed, fuel_slot_count: fuelSlotCount }
}

async function run (ctx, args) {
  const bot = ctx.bot
  if (!bot.entity) throw new ActionError('NOT_CONNECTED', 'Bot is not spawned')
  const input = resolveItem(bot, args.input)
  const fuel = resolveItem(bot, args.fuel)
  let window = null

  try {
    const opened = await openFurnaceAt(ctx, args.position)
    window = opened.window

    const inputSlot = slotItem(window, INPUT_SLOT)
    const fuelSlot = slotItem(window, FUEL_SLOT)
    const outputSlot = slotItem(window, OUTPUT_SLOT)

    // Old output or old input would make it impossible to attribute the
    // produced/retrieved items to this action.  Refuse rather than mixing.
    if (inputSlot) {
      throw new ActionError('FURNACE_INPUT_OCCUPIED', 'Furnace input slot is not empty; refusing to mix inputs')
    }
    if (outputSlot) {
      throw new ActionError('FURNACE_OUTPUT_OCCUPIED', 'Furnace output slot is not empty; refusing to mix outputs')
    }
    if (fuelSlot && fuelSlot.type !== fuel.id) {
      throw new ActionError('FURNACE_FUEL_MISMATCH', 'Furnace already contains a different fuel item')
    }

    // As with chests, bot.inventory is not updated until the window closes;
    // the player-inventory slots in the open window are the live state.
    const beforeInventory = windowInventoryCounts(window)
    if (countOf(beforeInventory, args.input) < args.input_count) {
      throw new ActionError('INSUFFICIENT_ITEMS',
        `Inventory has ${countOf(beforeInventory, args.input)} ${args.input}, need ${args.input_count}`)
    }
    if (countOf(beforeInventory, args.fuel) < args.fuel_count) {
      throw new ActionError('INSUFFICIENT_ITEMS',
        `Inventory has ${countOf(beforeInventory, args.fuel)} ${args.fuel}, need ${args.fuel_count}`)
    }

    ctx.setEffect({
      input: args.input,
      fuel: args.fuel,
      input_count: args.input_count,
      fuel_count: args.fuel_count,
      wait_seconds: args.wait_seconds,
      output_item: null,
      output_observed_count: 0,
      output_retrieved_count: 0,
      inventory_before: windowInventoryList(window)
    })

    await moveIntoSlot(ctx, window, input.id, args.input_count, INPUT_SLOT, INPUT_SLOT + 1)
    await ctx.sleep(200)
    ctx.check()
    const insertedInput = slotItem(window, INPUT_SLOT)
    if (!insertedInput || insertedInput.type !== input.id || insertedInput.count !== args.input_count) {
      throw new ActionError('SMELT_INPUT_NOT_INSERTED',
        `Furnace input contains ${insertedInput ? insertedInput.count : 0} instead of ${args.input_count}`)
    }

    const fuelBeforeInsert = countOf(windowInventoryCounts(window), args.fuel)
    await moveIntoSlot(ctx, window, fuel.id, args.fuel_count, FUEL_SLOT, FUEL_SLOT + 1)
    await ctx.sleep(250)
    ctx.check()

    const fuelAfterInsert = countOf(windowInventoryCounts(window), args.fuel)
    const fuelCheck = verifyFuelInsertion(
      fuelBeforeInsert,
      fuelAfterInsert,
      args.fuel_count,
      fuelSlotCount(window, fuel.id)
    )
    const fuelRemoved = fuelCheck.fuel_removed
    ctx.setEffect({
      fuel_removed_from_inventory: fuelRemoved,
      fuel_remaining_in_furnace: fuelCheck.fuel_slot_count,
      fuel_seconds: typeof window.fuelSeconds === 'number' ? window.fuelSeconds : null
    })

    const startedAt = Date.now()
    const limitMs = Math.floor(args.wait_seconds * 1000)
    let timedOut = false
    let currentInput = null
    let currentOutput = null
    let sawBurn = burnObserved(window)

    while (true) {
      ctx.check()
      if (bot.currentWindow !== window) {
        throw new ActionError('WINDOW_CLOSED', 'Furnace window closed unexpectedly')
      }
      currentInput = slotItem(window, INPUT_SLOT)
      currentOutput = slotItem(window, OUTPUT_SLOT)
      if (burnObserved(window)) sawBurn = true
      const inputEmpty = !currentInput || currentInput.count <= 0
      const hasOutput = Boolean(currentOutput && currentOutput.count > 0)
      const inputDone = inputEmpty && hasOutput
      if (inputDone) break
      if (Date.now() - startedAt >= limitMs) {
        timedOut = true
        break
      }
      await ctx.sleep(250)
    }

    currentInput = slotItem(window, INPUT_SLOT)
    currentOutput = slotItem(window, OUTPUT_SLOT)
    const remainingInput = currentInput ? currentInput.count : 0
    const outputCount = currentOutput ? currentOutput.count : 0
    const outputName = currentOutput ? canonicalName(currentOutput.name) : null

    ctx.setEffect({
      smelted_input_count: Math.max(0, args.input_count - remainingInput),
      remaining_input_count: remainingInput,
      output_item: outputName,
      output_observed_count: outputCount,
      timed_out: timedOut,
      burn_observed: sawBurn,
      fuel_remaining_in_furnace: fuelSlotCount(window, fuel.id)
    })

    if (!currentOutput || outputCount <= 0) {
      throw new ActionError('SMELT_NO_OUTPUT',
        remainingInput > 0 ? 'No smelt output appeared before the wait expired' : 'Furnace produced no output')
    }
    if (outputName === args.input) {
      throw new ActionError('SMELT_INVALID_OUTPUT', 'Furnace output is the same item as the input')
    }

    const beforeTake = windowInventoryCounts(window)
    const observed = outputCount
    await takeFromSlot(ctx, window, currentOutput.type, observed, OUTPUT_SLOT, OUTPUT_SLOT + 1)
    await ctx.sleep(200)
    ctx.check()

    const afterTake = windowInventoryCounts(window)
    const retrieved = deltaFor(beforeTake, afterTake, outputName)
    const outputLeft = slotItem(window, OUTPUT_SLOT)
    const outputLeftCount = outputLeft ? outputLeft.count : 0

    ctx.setEffect({
      output_retrieved_count: retrieved,
      output_remaining_count: outputLeftCount,
      inventory_after: windowInventoryList(window)
    })

    if (retrieved <= 0) {
      throw new ActionError('SMELT_RETRIEVE_FAILED', 'Observed furnace output was not retrieved into the inventory')
    }
    if (retrieved !== observed || outputLeftCount !== 0) {
      throw new ActionError('SMELT_RETRIEVE_INCOMPLETE',
        `Retrieved ${retrieved} of ${observed} observed output items`)
    }
    if (timedOut || remainingInput > 0) {
      throw new ActionError('SMELT_INCOMPLETE',
        `Smelt did not finish within ${args.wait_seconds}s (${remainingInput} input items left)`)
    }

    ctx.markVerified({
      output_item: outputName,
      output_observed_count: observed,
      output_retrieved_count: retrieved,
      fuel_removed_from_inventory: fuelRemoved
    })
  } finally {
    ctx.closeWindow()
  }
}

module.exports = { run, verifyFuelInsertion }
