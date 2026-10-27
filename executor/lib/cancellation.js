'use strict'

const { CancelledError } = require('./errors')

/**
 * Small cancellation primitive used by every action.  Action code must pass
 * every awaited Mineflayer call through `ctx.wait()` (or `ctx.sleep()`), which
 * checks this token both before and after the await.  That is what prevents a
 * callback that resolves after stop/timeout from starting another sub-action.
 */
class CancellationToken {
  constructor () {
    this.cancelled = false
    this.reason = null
    this._listeners = new Set()
  }

  cancel (reason = 'stop') {
    if (this.cancelled) return
    this.cancelled = true
    this.reason = reason
    const listeners = [...this._listeners]
    this._listeners.clear()
    for (const listener of listeners) {
      try {
        listener(reason)
      } catch {
        // cancellation listeners are cleanup only
      }
    }
  }

  throwIfCancelled () {
    if (this.cancelled) throw new CancelledError(this.reason)
  }

  check () {
    this.throwIfCancelled()
  }

  onCancel (listener) {
    if (this.cancelled) {
      try {
        listener(this.reason)
      } catch {
        // ignore cleanup failures
      }
      return () => {}
    }
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  async wait (promise) {
    this.throwIfCancelled()
    try {
      const value = await promise
      this.throwIfCancelled()
      return value
    } catch (err) {
      if (this.cancelled) throw new CancelledError(this.reason)
      throw err
    }
  }

  sleep (ms) {
    this.throwIfCancelled()
    if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let done = false
      let timer = null
      let unsubscribe = null
      const finish = (fn, value) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        if (unsubscribe) unsubscribe()
        fn(value)
      }
      timer = setTimeout(() => finish(resolve), ms)
      unsubscribe = this.onCancel((reason) => finish(reject, new CancelledError(reason)))
    })
  }
}

module.exports = { CancellationToken }
