'use strict'

const { ActionContext } = require('./action-context')
const { CancellationToken } = require('./cancellation')
const { ActionError, BusyError, AgentError } = require('./errors')

const DEFAULT_TIMEOUT_MS = 120000
const HARD_MAX_TIMEOUT_MS = 180000
const DEFAULT_HISTORY = 20

function iso (date) {
  return date.toISOString()
}

function clonePlain (value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

class ActionManager {
  constructor ({
    snapshot,
    worldId,
    onInterrupt,
    logger,
    maxHistory = DEFAULT_HISTORY,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}) {
    if (typeof snapshot !== 'function') throw new TypeError('ActionManager requires a snapshot function')
    this.snapshot = snapshot
    this.worldId = typeof worldId === 'function' ? worldId : () => worldId
    this.onInterrupt = typeof onInterrupt === 'function' ? onInterrupt : () => {}
    this.logger = logger || (() => {})
    this.maxHistory = Math.max(0, Math.floor(maxHistory))
    this.defaultTimeoutMs = defaultTimeoutMs
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.current = null
    this.history = []
    this._counter = 0
    this._idleResolvers = []
  }

  isBusy () {
    return this.current !== null
  }

  currentActionId () {
    return this.current ? this.current.record.action_id : null
  }

  start (kind, runner, options = {}) {
    if (this.current) throw new BusyError(this.current.record.action_id)
    if (typeof runner !== 'function') throw new TypeError('runner must be a function')

    const timeout = options.timeoutMs === undefined
      ? this.defaultTimeoutMs
      : options.timeoutMs
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > HARD_MAX_TIMEOUT_MS) {
      throw new RangeError(`action timeout must be in (0, ${HARD_MAX_TIMEOUT_MS}] ms`)
    }

    const id = `act-${Date.now().toString(36)}-${++this._counter}`
    const token = new CancellationToken()
    const record = {
      action_id: id,
      status: 'running',
      kind,
      started_at: iso(this.now()),
      finished_at: null,
      before: this._safeSnapshot(),
      after: null,
      effect: {},
      error: null
    }
    const entry = {
      record,
      token,
      ctx: new ActionContext({ bot: options.bot, token, worldId: this.worldId() }),
      timer: null,
      settled: false,
      timedOut: false,
      stopRequested: false
    }
    this.current = entry

    entry.timer = this.setTimer(() => {
      if (entry.settled) return
      entry.timedOut = true
      token.cancel('timeout')
      this._interrupt()
    }, timeout)

    setImmediate(() => {
      this._execute(entry, runner).catch((err) => {
        this.logger(`action manager internal error: ${err && err.stack ? err.stack : err}`)
      })
    })

    return { action_id: id, status: 'running' }
  }

  status (actionId) {
    const entry = this.current
    let record = null
    if (entry && entry.record.action_id === actionId) {
      record = entry.record
    } else {
      record = this.history.find((item) => item.action_id === actionId) || null
    }
    if (!record) return null
    return this._public(record)
  }

  stop () {
    const entry = this.current
    if (!entry) return { stopped: true }
    this._stopEntry(entry, 'stop')
    return { stopped: true, action_id: entry.record.action_id }
  }

  abort (reason = 'disconnect') {
    if (this.current) this._stopEntry(this.current, reason)
  }

  waitForIdle () {
    if (!this.current) return Promise.resolve()
    return new Promise((resolve) => this._idleResolvers.push(resolve))
  }

  _stopEntry (entry, reason) {
    if (entry.settled) return
    if (reason === 'stop') entry.stopRequested = true
    if (entry.timer) {
      this.clearTimer(entry.timer)
      entry.timer = null
    }
    entry.token.cancel(reason)
    this._interrupt()
  }

  _interrupt () {
    try {
      this.onInterrupt()
    } catch (err) {
      this.logger(`interrupt failed: ${err && err.message ? err.message : err}`)
    }
  }

  _safeSnapshot () {
    try {
      return clonePlain(this.snapshot())
    } catch (err) {
      this.logger(`snapshot failed: ${err && err.message ? err.message : err}`)
      return null
    }
  }

  async _execute (entry, runner) {
    const { record, token, ctx } = entry
    try {
      record.before = this._safeSnapshot()
      // If stop arrived between start() and this setImmediate callback, do not
      // even enter the action body (which might otherwise begin a new
      // Mineflayer operation synchronously).
      token.check()
      await runner(ctx)
      token.check()
      ctx.requireVerified()
      record.status = 'succeeded'
    } catch (err) {
      this._recordFailure(entry, err)
    } finally {
      if (entry.timer) {
        this.clearTimer(entry.timer)
        entry.timer = null
      }
      ctx.closeWindow()
      record.effect = clonePlain(ctx.effect) || {}
      record.after = this._safeSnapshot()
      record.finished_at = iso(this.now())
      entry.settled = true
      if (record.status === 'running') {
        // Defensive: an unexpected control-flow path must never leave a
        // running record dangling.
        record.status = 'failed'
        record.error = { code: 'ACTION_FAILED', message: 'Action ended without a final status' }
      }
      this.current = null
      this.history.unshift(record)
      if (this.history.length > this.maxHistory) this.history.length = this.maxHistory
      const resolvers = this._idleResolvers
      this._idleResolvers = []
      for (const resolve of resolvers) resolve()
    }
  }

  _recordFailure (entry, err) {
    const { record, token } = entry
    if (token.cancelled) {
      if (token.reason === 'stop') {
        record.status = 'cancelled'
        record.error = { code: 'ACTION_CANCELLED', message: 'Action cancelled by stop request' }
      } else if (token.reason === 'timeout') {
        record.status = 'failed'
        record.error = { code: 'ACTION_TIMEOUT', message: 'Action timed out' }
      } else {
        record.status = 'failed'
        record.error = { code: 'ACTION_ABORTED', message: `Action aborted (${token.reason})` }
      }
      return
    }
    if (err instanceof AgentError) {
      record.status = 'failed'
      record.error = { code: err.code, message: err.message }
      return
    }
    const message = err && typeof err.message === 'string' && err.message
      ? err.message
      : 'Unknown action error'
    record.status = 'failed'
    record.error = { code: 'ACTION_FAILED', message }
  }

  _public (record) {
    const out = {
      action_id: record.action_id,
      status: record.status,
      kind: record.kind,
      started_at: record.started_at,
      world_id: this.worldId(),
      observed_at: iso(this.now())
    }
    if (record.finished_at) out.finished_at = record.finished_at
    if (record.before !== null) out.before = record.before
    if (record.after !== null) out.after = record.after
    if (record.effect && Object.keys(record.effect).length > 0) out.effect = record.effect
    if (record.error) out.error = record.error
    return out
  }
}

module.exports = {
  ActionManager,
  DEFAULT_TIMEOUT_MS,
  HARD_MAX_TIMEOUT_MS,
  DEFAULT_HISTORY,
  ActionError
}
