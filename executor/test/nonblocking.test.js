'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { BotRuntime } = require('../lib/runtime')

function fakeBot () {
  return {
    username: 'BasicAgent',
    entity: { position: { x: 0, y: 64, z: 0 } },
    health: 20,
    food: 20,
    game: { dimension: 'minecraft:overworld', minY: -64, height: 384 },
    players: {},
    inventory: { items: () => [] },
    currentWindow: null
  }
}

function withTimeout (promise, ms, label) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} was blocked`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

test('observe and action_status respond while a mutation action is awaiting', async () => {
  const runtime = new BotRuntime({
    config: {
      host: '127.0.0.1',
      port: 25575,
      version: '1.21.1',
      username: 'BasicAgent',
      auth: 'offline',
      world_id: 'basic-lab-v1'
    },
    sendEvent: () => {},
    logger: () => {},
    exit: () => {}
  })
  const bot = fakeBot()
  runtime.bot = bot
  runtime.ready = true

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { action_id: actionId } = runtime.manager.start('collect', async (ctx) => {
    await ctx.wait(gate)
    ctx.markVerified({})
  }, { bot, timeoutMs: 5000 })

  // The action is deliberately blocked in an await.  These requests use the
  // exact same JSONL dispatch path as the server and must not queue behind it.
  const observed = await withTimeout(
    runtime.handle({ id: 'o1', op: 'observe', args: {} }),
    500,
    'observe'
  )
  assert.equal(observed.connected, true)
  assert.equal(observed.username, 'BasicAgent')
  assert.ok(observed.observed_at)

  const status = await withTimeout(
    runtime.handle({ id: 's1', op: 'action_status', args: { action_id: actionId } }),
    500,
    'action_status'
  )
  assert.equal(status.status, 'running')
  assert.equal(status.action_id, actionId)

  release()
  await runtime.manager.waitForIdle()
  const done = runtime.manager.status(actionId)
  assert.equal(done.status, 'succeeded')
})
