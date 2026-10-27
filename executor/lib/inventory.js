'use strict'

function canonicalName (name) {
  if (typeof name !== 'string' || name.length === 0) return null
  return name.startsWith('minecraft:') ? name : `minecraft:${name}`
}

function countItems (items) {
  const counts = new Map()
  for (const item of items || []) {
    if (!item) continue
    const name = canonicalName(item.name)
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + (item.count || 0))
  }
  return counts
}

function inventoryCounts (bot) {
  if (!bot || !bot.inventory) return new Map()
  return countItems(bot.inventory.items())
}

function inventoryList (bot) {
  return [...inventoryCounts(bot).entries()]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count }))
}

function countOf (counts, item) {
  const name = canonicalName(item && item.name ? item.name : item)
  return name ? (counts.get(name) || 0) : 0
}

function diffCounts (before, after) {
  const names = new Set([...before.keys(), ...after.keys()])
  const delta = {}
  for (const name of [...names].sort()) {
    const change = (after.get(name) || 0) - (before.get(name) || 0)
    if (change !== 0) delta[name] = change
  }
  return delta
}

function deltaFor (before, after, item) {
  return countOf(after, item) - countOf(before, item)
}

module.exports = {
  canonicalName,
  countItems,
  inventoryCounts,
  inventoryList,
  countOf,
  diffCounts,
  deltaFor
}
