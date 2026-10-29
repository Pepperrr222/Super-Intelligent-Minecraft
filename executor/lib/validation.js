'use strict'

const { ValidationError } = require('./errors')
const { validateSayMessage } = require('./say')

const CANONICAL_ID = /^minecraft:[a-z0-9_]+$/
const USERNAME = /^[A-Za-z0-9_]{1,16}$/
const MAX_WORLD_COORD = 30000000

const OPS = new Set([
  'observe',
  'find_blocks',
  'inspect_container',
  'recipes',
  'act',
  'action_status',
  'stop',
  'say',
  'shutdown'
])

const ACTION_KINDS = new Set([
  'goto',
  'follow',
  'collect',
  'craft',
  'place',
  'deposit',
  'withdraw',
  'smelt'
])

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertPlainObject (value, path) {
  if (!isPlainObject(value)) throw new ValidationError(`${path} must be an object`, path)
  return value
}

function assertNoExtraKeys (value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ValidationError(`${path}.${key} is not allowed`, `${path}.${key}`)
  }
}

function assertString (value, path, opts = {}) {
  if (typeof value !== 'string') throw new ValidationError(`${path} must be a string`, path)
  const min = opts.min === undefined ? 0 : opts.min
  const max = opts.max === undefined ? Infinity : opts.max
  if (value.length < min || value.length > max) {
    throw new ValidationError(`${path} length must be between ${min} and ${max}`, path)
  }
  return value
}

function assertCanonicalId (value, path) {
  assertString(value, path, { min: 3, max: 128 })
  if (!CANONICAL_ID.test(value)) {
    throw new ValidationError(`${path} must be a canonical minecraft:snake_case id`, path)
  }
  return value
}

function assertFiniteNumber (value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${path} must be a finite number`, path)
  }
  return value
}

function assertInteger (value, path, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(`${path} must be an integer`, path)
  }
  if (value < min || value > max) {
    throw new ValidationError(`${path} must be between ${min} and ${max}`, path)
  }
  return value
}

function assertWorldCoordinate (value, path, integer) {
  assertFiniteNumber(value, path)
  if (integer && !Number.isInteger(value)) {
    throw new ValidationError(`${path} must be an integer block coordinate`, path)
  }
  if (value < -MAX_WORLD_COORD || value > MAX_WORLD_COORD) {
    throw new ValidationError(`${path} is outside the world boundary`, path)
  }
  return value
}

function readPosition (value, path, integer) {
  assertPlainObject(value, path)
  assertNoExtraKeys(value, ['x', 'y', 'z'], path)
  for (const axis of ['x', 'y', 'z']) {
    if (!(axis in value)) throw new ValidationError(`${path}.${axis} is required`, `${path}.${axis}`)
    assertWorldCoordinate(value[axis], `${path}.${axis}`, integer)
  }
  return { x: value.x, y: value.y, z: value.z }
}

function validateEnvelope (request) {
  if (!isPlainObject(request)) throw new ValidationError('request must be an object', 'request')
  if (typeof request.id !== 'string' || request.id.length === 0 || request.id.length > 128) {
    throw new ValidationError('id must be a non-empty string of at most 128 characters', 'id')
  }
  if (typeof request.op !== 'string' || !OPS.has(request.op)) {
    throw new ValidationError(`op must be one of: ${[...OPS].join(', ')}`, 'op')
  }
  const args = request.args === undefined ? {} : request.args
  assertPlainObject(args, 'args')
  return { id: request.id, op: request.op, args }
}

function validateObserve (args) {
  assertNoExtraKeys(args, [], 'args')
  return {}
}

function validateFindBlocks (args) {
  assertNoExtraKeys(args, ['names', 'radius', 'limit'], 'args')
  if (!Array.isArray(args.names)) throw new ValidationError('args.names must be an array', 'args.names')
  if (args.names.length < 1 || args.names.length > 32) {
    throw new ValidationError('args.names must contain between 1 and 32 ids', 'args.names')
  }
  const names = []
  const seen = new Set()
  for (let i = 0; i < args.names.length; i++) {
    const name = assertCanonicalId(args.names[i], `args.names[${i}]`)
    if (seen.has(name)) throw new ValidationError(`args.names contains duplicate ${name}`, `args.names[${i}]`)
    seen.add(name)
    names.push(name)
  }
  const radius = assertInteger(args.radius, 'args.radius', 1, 32)
  const limit = assertInteger(args.limit, 'args.limit', 1, 16)
  return { names, radius, limit }
}

function validateInspectContainer (args) {
  assertNoExtraKeys(args, ['position'], 'args')
  if (!('position' in args)) throw new ValidationError('args.position is required', 'args.position')
  return { position: readPosition(args.position, 'args.position', true) }
}

function validateRecipes (args) {
  assertNoExtraKeys(args, ['item'], 'args')
  if (!('item' in args)) throw new ValidationError('args.item is required', 'args.item')
  return { item: assertCanonicalId(args.item, 'args.item') }
}

function validateActionStatus (args) {
  assertNoExtraKeys(args, ['action_id'], 'args')
  if (!('action_id' in args)) throw new ValidationError('args.action_id is required', 'args.action_id')
  return { action_id: assertString(args.action_id, 'args.action_id', { min: 1, max: 128 }) }
}

function validateEmpty (args) {
  assertNoExtraKeys(args, [], 'args')
  return {}
}

function validateSay (args) {
  assertNoExtraKeys(args, ['message'], 'args')
  if (!('message' in args)) throw new ValidationError('args.message is required', 'args.message')
  return { message: validateSayMessage(args.message) }
}

function validateAct (args) {
  assertNoExtraKeys(args, ['kind', 'position', 'range', 'player', 'duration_seconds', 'block',
    'count', 'item', 'input', 'fuel', 'input_count', 'fuel_count', 'wait_seconds'], 'args')
  if (!('kind' in args)) throw new ValidationError('args.kind is required', 'args.kind')
  if (typeof args.kind !== 'string' || !ACTION_KINDS.has(args.kind)) {
    throw new ValidationError(`args.kind must be one of: ${[...ACTION_KINDS].join(', ')}`, 'args.kind')
  }
  const kind = args.kind

  switch (kind) {
    case 'place': {
      assertNoExtraKeys(args, ['kind', 'position', 'item'], 'args')
      return { kind, position: readPosition(args.position, 'args.position', true), item: assertCanonicalId(args.item, 'args.item') }
    }
    case 'goto': {
      assertNoExtraKeys(args, ['kind', 'position', 'range'], 'args')
      if (!('position' in args)) throw new ValidationError('args.position is required', 'args.position')
      if (!('range' in args)) throw new ValidationError('args.range is required', 'args.range')
      return {
        kind,
        position: readPosition(args.position, 'args.position', false),
        range: assertInteger(args.range, 'args.range', 1, 4)
      }
    }
    case 'follow': {
      assertNoExtraKeys(args, ['kind', 'player', 'duration_seconds'], 'args')
      if (!('player' in args)) throw new ValidationError('args.player is required', 'args.player')
      if (!('duration_seconds' in args)) throw new ValidationError('args.duration_seconds is required', 'args.duration_seconds')
      const player = assertString(args.player, 'args.player', { min: 1, max: 16 })
      if (!USERNAME.test(player)) {
        throw new ValidationError('args.player must be a plain Minecraft username', 'args.player')
      }
      return {
        kind,
        player,
        duration_seconds: assertInteger(args.duration_seconds, 'args.duration_seconds', 1, 60)
      }
    }
    case 'collect': {
      assertNoExtraKeys(args, ['kind', 'block', 'count'], 'args')
      if (!('block' in args)) throw new ValidationError('args.block is required', 'args.block')
      if (!('count' in args)) throw new ValidationError('args.count is required', 'args.count')
      return {
        kind,
        block: assertCanonicalId(args.block, 'args.block'),
        count: assertInteger(args.count, 'args.count', 1, 64)
      }
    }
    case 'craft': {
      assertNoExtraKeys(args, ['kind', 'item', 'count'], 'args')
      if (!('item' in args)) throw new ValidationError('args.item is required', 'args.item')
      if (!('count' in args)) throw new ValidationError('args.count is required', 'args.count')
      return {
        kind,
        item: assertCanonicalId(args.item, 'args.item'),
        count: assertInteger(args.count, 'args.count', 1, 64)
      }
    }
    case 'deposit':
    case 'withdraw': {
      assertNoExtraKeys(args, ['kind', 'position', 'item', 'count'], 'args')
      if (!('position' in args)) throw new ValidationError('args.position is required', 'args.position')
      if (!('item' in args)) throw new ValidationError('args.item is required', 'args.item')
      if (!('count' in args)) throw new ValidationError('args.count is required', 'args.count')
      return {
        kind,
        position: readPosition(args.position, 'args.position', true),
        item: assertCanonicalId(args.item, 'args.item'),
        count: assertInteger(args.count, 'args.count', 1, 64)
      }
    }
    case 'smelt': {
      assertNoExtraKeys(args, ['kind', 'position', 'input', 'fuel', 'input_count', 'fuel_count', 'wait_seconds'], 'args')
      for (const key of ['position', 'input', 'fuel', 'input_count', 'fuel_count', 'wait_seconds']) {
        if (!(key in args)) throw new ValidationError(`args.${key} is required`, `args.${key}`)
      }
      return {
        kind,
        position: readPosition(args.position, 'args.position', true),
        input: assertCanonicalId(args.input, 'args.input'),
        fuel: assertCanonicalId(args.fuel, 'args.fuel'),
        input_count: assertInteger(args.input_count, 'args.input_count', 1, 64),
        fuel_count: assertInteger(args.fuel_count, 'args.fuel_count', 1, 64),
        wait_seconds: (() => {
          const value = assertFiniteNumber(args.wait_seconds, 'args.wait_seconds')
          if (value < 1 || value > 120) throw new ValidationError('args.wait_seconds must be between 1 and 120', 'args.wait_seconds')
          return value
        })()
      }
    }
    default:
      throw new ValidationError('unsupported action kind', 'args.kind')
  }
}

const VALIDATORS = {
  observe: validateObserve,
  find_blocks: validateFindBlocks,
  inspect_container: validateInspectContainer,
  recipes: validateRecipes,
  act: validateAct,
  action_status: validateActionStatus,
  stop: validateEmpty,
  say: validateSay,
  shutdown: validateEmpty
}

function validateArgs (op, args) {
  const validator = VALIDATORS[op]
  if (!validator) throw new ValidationError(`Unknown operation ${op}`, 'op')
  return validator(args)
}

module.exports = {
  OPS,
  ACTION_KINDS,
  CANONICAL_ID,
  validateEnvelope,
  validateArgs,
  // exported for unit tests and reuse
  readPosition,
  assertCanonicalId
}
