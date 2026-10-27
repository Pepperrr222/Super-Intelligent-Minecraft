'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { ActionManager } = require('../lib/action-manager')

function makeManager (overrides = {}) {
  let counter = 0
  return new ActionManager({
    snapshot: () => ({
      connected: true,
      world_id: 'basic-lab-v1@minecraft:overworld',
      observed_at: new Date().toISOString(),
      inventory: [{ name: 'minecraft:dirt', count: ++counter }]
    }),
    worldId: 'basic-lab-v1@minecraft:overworld',
    now: () => new Date('2026-10-27T00:00:00.000Z'),
    ...overrides
  })
}

test('action lifecycle: running -> verified success with before/after/effect', async () => {
  const manager = makeManager()
  const started = manager.start('goto', async (ctx) => {
    ctx.setEffect({ distance_to_target: 0 })
    ctx.markVerified({ verified_reason: 'test' })
  })

  assert.equal(started.status, 'running')
  assert.equal(manager.isBusy(), true)
  assert.throws(() => manager.start('goto', async () => {}), (err) => err.code === 'BUSY')

  const running = manager.status(started.action_id)
  assert.equal(running.status, 'running')
  assert.equal(running.kind, 'goto')
  assert.ok(running.world_id)
  assert.ok(running.observed_at)

  await manager.waitForIdle()
  const done = manager.status(started.action_id)
  assert.equal(done.status, 'succeeded')
  assert.equal(done.effect.distance_to_target, 0)
  assert.equal(done.effect.verified_reason, 'test')
  assert.ok(done.before)
  assert.ok(done.after)
  assert.ok(done.finished_at)
  assert.equal(manager.isBusy(), false)
})

test('action lifecycle: unverified completion is failed', async () => {
  const manager = makeManager()
  const { action_id: id } = manager.start('goto', async (ctx) => {
    ctx.setEffect({ distance_to_target: 100 })
  })
  await manager.waitForIdle()
  const status = manager.status(id)
  assert.equal(status.status, 'failed')
  assert.equal(status.error.code, 'EFFECT_UNVERIFIED')
  assert.deepEqual(status.effect, { distance_to_target: 100 })
})

test('action lifecycle: stop keeps busy until the awaited call settles and prevents later steps', async () => {
  const manager = makeManager()
  let release
  let ranAfterAwait = false
  const deferred = new Promise((resolve) => { release = resolve })

  const { action_id: id } = manager.start('collect', async (ctx) => {
    await ctx.wait(deferred)
    ranAfterAwait = true
    ctx.setEffect({ should_not_exist: true })
  })

  const stopped = manager.stop()
  assert.deepEqual(stopped, { stopped: true, action_id: id })
  assert.equal(manager.isBusy(), true, 'mutation lock must remain held while the await settles')
  assert.equal(manager.status(id).status, 'running')

  release()
  await manager.waitForIdle()
  const status = manager.status(id)
  assert.equal(status.status, 'cancelled')
  assert.equal(status.error.code, 'ACTION_CANCELLED')
  assert.equal(ranAfterAwait, false)
  assert.equal(status.effect, undefined)
  assert.equal(manager.isBusy(), false)
})

test('action lifecycle: timeout fails, records partial effect, and releases the lock', async () => {
  const manager = makeManager({ defaultTimeoutMs: 40 })
  const { action_id: id } = manager.start('follow', async (ctx) => {
    ctx.setEffect({ followed_seconds: 0 })
    await ctx.sleep(5000)
    ctx.markVerified({ followed_seconds: 5 })
  })
  await manager.waitForIdle()
  const status = manager.status(id)
  assert.equal(status.status, 'failed')
  assert.equal(status.error.code, 'ACTION_TIMEOUT')
  assert.deepEqual(status.effect, { followed_seconds: 0 })
  assert.equal(manager.isBusy(), false)
})

test('action lifecycle: failures retain partial effects', async () => {
  const manager = makeManager()
  const { action_id: id } = manager.start('deposit', async (ctx) => {
    ctx.setEffect({ actual_moved: 2, requested_count: 5 })
    const { ActionError } = require('../lib/errors')
    throw new ActionError('TRANSFER_INCOMPLETE', 'partial transfer')
  })
  await manager.waitForIdle()
  const status = manager.status(id)
  assert.equal(status.status, 'failed')
  assert.equal(status.error.code, 'TRANSFER_INCOMPLETE')
  assert.equal(status.effect.actual_moved, 2)
})

test('action history is finite and unknown ids are reported as absent', async () => {
  const manager = makeManager({ maxHistory: 2 })
  const ids = []
  for (let i = 0; i < 3; i++) {
    const { action_id: id } = manager.start('goto', async (ctx) => ctx.markVerified({}))
    ids.push(id)
    await manager.waitForIdle()
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(manager.status(ids[0]), null)
  assert.ok(manager.status(ids[1]))
  assert.ok(manager.status(ids[2]))
  assert.equal(manager.status('missing'), null)
})

test('stop with no action is a harmless no-op', () => {
  const manager = makeManager()
  assert.deepEqual(manager.stop(), { stopped: true })
})

test('same action id can be polled while running and after settling', async () => {
  const manager = makeManager()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { action_id: id } = manager.start('craft', async (ctx) => {
    await ctx.wait(gate)
    ctx.markVerified({ produced_count: 1 })
  })
  assert.equal(manager.status(id).status, 'running')
  release()
  await manager.waitForIdle()
  assert.equal(manager.status(id).status, 'succeeded')
})
