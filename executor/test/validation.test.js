'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { validateEnvelope, validateArgs } = require('../lib/validation')
const { ValidationError } = require('../lib/errors')

function invalid (fn, code = 'INVALID_ARGS') {
  assert.throws(fn, (err) => err instanceof ValidationError && err.code === code)
}

test('envelope validates id, op and args object', () => {
  assert.deepEqual(validateEnvelope({ id: '1', op: 'observe' }), { id: '1', op: 'observe', args: {} })
  invalid(() => validateEnvelope({ id: '', op: 'observe' }))
  invalid(() => validateEnvelope({ id: '1', op: 'nope' }))
  invalid(() => validateEnvelope({ id: '1', op: 'observe', args: [] }))
  invalid(() => validateEnvelope(null))
})

test('observe/stop/shutdown reject extra arguments', () => {
  assert.deepEqual(validateArgs('observe', {}), {})
  assert.deepEqual(validateArgs('stop', {}), {})
  assert.deepEqual(validateArgs('shutdown', {}), {})
  invalid(() => validateArgs('observe', { x: 1 }))
  invalid(() => validateArgs('stop', { force: true }))
})

test('find_blocks enforces canonical ids, radius and limit', () => {
  assert.deepEqual(
    validateArgs('find_blocks', { names: ['minecraft:oak_log'], radius: 24, limit: 8 }),
    { names: ['minecraft:oak_log'], radius: 24, limit: 8 }
  )
  invalid(() => validateArgs('find_blocks', { names: ['oak_log'], radius: 24, limit: 8 }))
  invalid(() => validateArgs('find_blocks', { names: ['minecraft:oak_log'], radius: 0, limit: 8 }))
  invalid(() => validateArgs('find_blocks', { names: ['minecraft:oak_log'], radius: 33, limit: 8 }))
  invalid(() => validateArgs('find_blocks', { names: ['minecraft:oak_log'], radius: 24, limit: 17 }))
  invalid(() => validateArgs('find_blocks', {
    names: ['minecraft:oak_log', 'minecraft:oak_log'], radius: 24, limit: 8
  }))
  invalid(() => validateArgs('find_blocks', { names: [], radius: 24, limit: 8 }))
})

test('act validates every kind and rejects extra fields', () => {
  assert.deepEqual(validateArgs('act', {
    kind: 'goto', position: { x: 1.5, y: 64, z: -3 }, range: 2
  }), { kind: 'goto', position: { x: 1.5, y: 64, z: -3 }, range: 2 })
  invalid(() => validateArgs('act', { kind: 'goto', position: { x: 1, y: 64, z: 1 }, range: 5 }))
  invalid(() => validateArgs('act', { kind: 'goto', position: { x: 1, y: 64 }, range: 2 }))
  invalid(() => validateArgs('act', {
    kind: 'goto', position: { x: 1, y: 64, z: 1 }, range: 2, speed: 3
  }))

  assert.deepEqual(validateArgs('act', { kind: 'follow', player: 'Doctor_Pepper', duration_seconds: 10 }),
    { kind: 'follow', player: 'Doctor_Pepper', duration_seconds: 10 })
  invalid(() => validateArgs('act', { kind: 'follow', player: 'bad player', duration_seconds: 10 }))
  invalid(() => validateArgs('act', { kind: 'follow', player: 'Doctor_Pepper', duration_seconds: 0 }))

  assert.deepEqual(validateArgs('act', { kind: 'collect', block: 'minecraft:oak_log', count: 4 }),
    { kind: 'collect', block: 'minecraft:oak_log', count: 4 })
  invalid(() => validateArgs('act', { kind: 'collect', block: 'minecraft:oak_log', count: 65 }))

  assert.deepEqual(validateArgs('act', { kind: 'craft', item: 'minecraft:stick', count: 4 }),
    { kind: 'craft', item: 'minecraft:stick', count: 4 })

  const container = { x: 1, y: 64, z: 2 }
  assert.deepEqual(validateArgs('act', { kind: 'deposit', position: container, item: 'minecraft:dirt', count: 2 }),
    { kind: 'deposit', position: container, item: 'minecraft:dirt', count: 2 })
  invalid(() => validateArgs('act', {
    kind: 'deposit', position: { x: 1.5, y: 64, z: 2 }, item: 'minecraft:dirt', count: 2
  }))

  const smelt = {
    kind: 'smelt',
    position: container,
    input: 'minecraft:raw_iron',
    fuel: 'minecraft:coal',
    input_count: 2,
    fuel_count: 1,
    wait_seconds: 30
  }
  assert.equal(validateArgs('act', smelt).input_count, 2)
  invalid(() => validateArgs('act', { ...smelt, wait_seconds: 0 }))
  invalid(() => validateArgs('act', { ...smelt, wait_seconds: 121 }))
  invalid(() => validateArgs('act', { ...smelt, input_count: 0 }))
  invalid(() => validateArgs('act', { ...smelt, kind: 'brew' }))
})

test('inspect_container/recipes/action_status validate required args', () => {
  assert.deepEqual(validateArgs('inspect_container', { position: { x: 1, y: 2, z: 3 } }),
    { position: { x: 1, y: 2, z: 3 } })
  invalid(() => validateArgs('inspect_container', { position: { x: 1, y: 2, z: 3 }, peek: true }))
  assert.deepEqual(validateArgs('recipes', { item: 'minecraft:stick' }), { item: 'minecraft:stick' })
  assert.deepEqual(validateArgs('action_status', { action_id: 'act-1' }), { action_id: 'act-1' })
  invalid(() => validateArgs('action_status', {}))
})

test('say rejects commands, control characters, empty and oversize messages', () => {
  assert.deepEqual(validateArgs('say', { message: 'hello there' }), { message: 'hello there' })
  assert.deepEqual(validateArgs('say', { message: ' /help' }), { message: ' /help' })
  invalid(() => validateArgs('say', { message: '/help' }))
  invalid(() => validateArgs('say', { message: '' }))
  invalid(() => validateArgs('say', { message: 'x'.repeat(201) }))
  invalid(() => validateArgs('say', { message: 'line\nbreak' }))
  invalid(() => validateArgs('say', { message: '/say hack' }))
  invalid(() => validateArgs('say', { message: 'hello', extra: 1 }))
})
