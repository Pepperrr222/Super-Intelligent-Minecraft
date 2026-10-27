'use strict'

const { ActionError } = require('./errors')

/**
 * Per-action state.  All action code must use `wait`/`sleep` for asynchronous
 * work so the token is checked after every await.  `window` is tracked here so
 * both the action's finally block and the manager can close it exactly once.
 */
class ActionContext {
  constructor ({ bot, token, worldId }) {
    this.bot = bot
    this.token = token
    this.world_id = worldId
    this.effect = {}
    this.verified = false
    this.window = null
  }

  check () {
    this.token.check()
  }

  async wait (promise) {
    return this.token.wait(promise)
  }

  async sleep (ms) {
    return this.token.sleep(ms)
  }

  setEffect (patch) {
    Object.assign(this.effect, patch)
  }

  markVerified (patch) {
    if (patch) this.setEffect(patch)
    this.verified = true
  }

  setWindow (window) {
    this.window = window
    return window
  }

  closeWindow () {
    const window = this.window
    this.window = null
    if (!window || !this.bot) return
    try {
      if (this.bot.currentWindow !== window) return
      if (typeof window.close === 'function') {
        // Mineflayer's extended windows emit their own 'close' event; furnace
        // windows rely on it to detach progress-bar listeners.
        window.close()
      } else {
        this.bot.closeWindow(window)
      }
    } catch {
      // Window may already have been closed by the server.
    }
  }

  requireVerified () {
    if (!this.verified) {
      throw new ActionError('EFFECT_UNVERIFIED', 'Action finished without an observable verified effect')
    }
  }
}

module.exports = { ActionContext }
