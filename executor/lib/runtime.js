'use strict'

const { ActionManager } = require('./action-manager')
const { ActionContext } = require('./action-context')
const { CancellationToken } = require('./cancellation')
const { ActionError, BusyError } = require('./errors')
const { validateEnvelope, validateArgs } = require('./validation')
const { observe, snapshotState, makeWorldId, nowIso, round } = require('./observation')
const { canonicalName } = require('./inventory')
const { resolveBlock, resolveItem, configureMovements, stopPathfinding } = require('./game')
const { getRunner, timeoutFor } = require('./actions')
const {
  CHEST_BLOCKS,
  FURNACE_BLOCKS,
  CHEST_WINDOW_TYPES,
  FURNACE_WINDOW_TYPES,
  openContainerAt,
  containerItems
} = require('./containers')
const { sendSay } = require('./say')

const INSPECT_BLOCKS = new Set([...CHEST_BLOCKS, ...FURNACE_BLOCKS])
const INSPECT_WINDOW_TYPES = new Set([...CHEST_WINDOW_TYPES, ...FURNACE_WINDOW_TYPES])
const INSPECT_TIMEOUT_MS = 20000
const CONNECT_TIMEOUT_MS = 60000

function reasonText (reason) {
  if (typeof reason === 'string') return reason
  if (reason === undefined || reason === null) return 'disconnected'
  try {
    const text = JSON.stringify(reason)
    return text.length > 500 ? `${text.slice(0, 500)}...` : text
  } catch {
    return 'disconnected'
  }
}

class BotRuntime {
  constructor ({ config, sendEvent, logger, exit = (code) => process.exit(code) }) {
    this.config = config
    this.sendEvent = sendEvent || (() => {})
    this.logger = logger || (() => {})
    this.exit = exit
    this.bot = null
    this.ready = false
    this.connected = false
    this.shuttingDown = false
    this.inspecting = false
    this.inspectToken = null
    this.connectPromise = null
    this.kickReason = null
    this._exitScheduled = false
    this.manager = new ActionManager({
      snapshot: () => this.snapshot(),
      worldId: () => this.worldId(),
      onInterrupt: () => this.interrupt(),
      logger: this.logger,
      maxHistory: 20,
      defaultTimeoutMs: 120000
    })
  }

  worldId () {
    return makeWorldId(this.config.world_id, this.bot)
  }

  snapshot () {
    return snapshotState(this.bot, this.worldId(), this.ready)
  }

  connect () {
    if (!this.connectPromise) {
      this.connectPromise = this._connect().catch((err) => {
        this.ready = false
        this.connected = false
        this.logger(`connect failed: ${err && err.stack ? err.stack : err}`)
        try {
          this.sendEvent('error', { code: err.code || 'CONNECT_FAILED', message: err.message })
        } catch {
          // transport may be gone
        }
        throw err
      })
    }
    return this.connectPromise
  }

  async _connect () {
    let mineflayer
    let pathfinder
    try {
      mineflayer = require('mineflayer')
      pathfinder = require('mineflayer-pathfinder').pathfinder
    } catch (err) {
      const wrapped = new ActionError('DEPENDENCY_MISSING',
        'mineflayer and mineflayer-pathfinder must be installed (npm install in executor)')
      wrapped.cause = err
      throw wrapped
    }

    const bot = mineflayer.createBot({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      auth: this.config.auth,
      version: this.config.version,
      hideErrors: true
    })
    this.bot = bot
    bot.loadPlugin(pathfinder)

    bot.on('chat', (username, message) => {
      this.sendEvent('chat', { username, message })
    })
    bot.on('error', (err) => {
      this.connected = false
      this.logger(`minecraft error: ${err && err.message ? err.message : err}`)
      try {
        this.sendEvent('error', {
          code: 'MINECRAFT_ERROR',
          message: (err && err.message) || 'Minecraft client error'
        })
      } catch {
        // transport may be gone
      }
    })
    bot.on('kicked', (reason) => {
      this.kickReason = reasonText(reason)
      this.logger(`kicked: ${this.kickReason}`)
    })
    bot.on('end', (reason) => {
      const wasReady = this.ready
      this.ready = false
      this.connected = false
      this.manager.abort('disconnect')
      this.logger(`connection ended: ${reasonText(this.kickReason || reason)}`)
      if (wasReady && !this.shuttingDown) {
        this.sendEvent('disconnect', { reason: this.kickReason || reasonText(reason) })
      }
    })

    await this._waitForSpawn(bot)
    configureMovements(bot)
    this.connected = true
    this.ready = true
    this.sendEvent('ready', {
      username: bot.username,
      version: this.config.version,
      world_id: this.worldId()
    })
  }

  _waitForSpawn (bot) {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        finish(() => reject(new ActionError('CONNECT_TIMEOUT', 'Timed out waiting for the Minecraft spawn event')))
        try {
          bot.end('connection timeout')
        } catch {
          // ignore
        }
      }, CONNECT_TIMEOUT_MS)

      const onSpawn = () => finish(resolve)
      const onError = (err) => finish(() => reject(err))
      const onEnd = (reason) => finish(() => reject(
        new ActionError('CONNECT_FAILED', `Connection ended before spawn: ${reasonText(reason)}`)))

      function finish (fn) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        bot.removeListener('spawn', onSpawn)
        bot.removeListener('error', onError)
        bot.removeListener('end', onEnd)
        fn()
      }

      bot.once('spawn', onSpawn)
      bot.once('error', onError)
      bot.once('end', onEnd)
    })
  }

  async handle (request) {
    const envelope = validateEnvelope(request)
    const args = validateArgs(envelope.op, envelope.args)
    if (this.shuttingDown) {
      throw new ActionError('SHUTTING_DOWN', 'Executor is shutting down')
    }
    if (envelope.op === 'shutdown') {
      this._beginShutdown(200)
      return { shutdown: true }
    }
    const availableWhileDisconnected = new Set(['observe', 'action_status', 'stop'])
    if (!this.ready && !availableWhileDisconnected.has(envelope.op)) {
      throw new ActionError('NOT_READY', 'Minecraft client is not connected and spawned yet')
    }

    switch (envelope.op) {
      case 'observe':
        return this._observe()
      case 'find_blocks':
        return this._findBlocks(args)
      case 'inspect_container':
        return this._inspectContainer(args)
      case 'recipes':
        return this._recipes(args)
      case 'act':
        return this._act(args)
      case 'action_status':
        return this._actionStatus(args)
      case 'stop':
        return this._stop()
      case 'say':
        return sendSay(this.bot, args.message, null)
      default:
        throw new ActionError('UNKNOWN_OP', `Unsupported operation ${envelope.op}`)
    }
  }

  _observe () {
    return observe(this.bot, this.worldId(), this.ready)
  }

  _findBlocks (args) {
    if (!this.bot.entity) throw new ActionError('NOT_CONNECTED', 'Bot is not spawned')
    const blockTypes = args.names.map((name) => resolveBlock(this.bot, name))
    const positions = this.bot.findBlocks({
      matching: blockTypes.map((block) => block.id),
      maxDistance: args.radius,
      count: args.limit
    })
    const blocks = []
    for (const position of positions) {
      const block = this.bot.blockAt(position)
      if (!block) continue
      blocks.push({
        name: canonicalName(block.name),
        position: { x: block.position.x, y: block.position.y, z: block.position.z },
        distance: round(this.bot.entity.position.distanceTo(block.position))
      })
    }
    blocks.sort((a, b) => a.distance - b.distance)
    return {
      blocks: blocks.slice(0, args.limit),
      observed_at: nowIso(),
      world_id: this.worldId()
    }
  }

  async _inspectContainer (args) {
    if (this.manager.isBusy()) throw new BusyError(this.manager.currentActionId())
    if (this.inspecting) throw new BusyError(null)
    this.inspecting = true
    const token = new CancellationToken()
    this.inspectToken = token
    const timer = setTimeout(() => {
      token.cancel('timeout')
      this.interrupt()
    }, INSPECT_TIMEOUT_MS)
    const ctx = new ActionContext({ bot: this.bot, token, worldId: this.worldId() })
    try {
      const opened = await openContainerAt(ctx, args.position, INSPECT_BLOCKS, INSPECT_WINDOW_TYPES, 'container')
      const items = containerItems(opened.window)
      return {
        type: opened.window.type,
        position: args.position,
        items,
        world_id: this.worldId(),
        observed_at: nowIso()
      }
    } catch (err) {
      if (token.cancelled && token.reason === 'timeout') {
        throw new ActionError('INSPECT_TIMEOUT', 'Container inspection timed out')
      }
      throw err
    } finally {
      clearTimeout(timer)
      ctx.closeWindow()
      this.inspecting = false
      this.inspectToken = null
    }
  }

  _recipes (args) {
    const item = resolveItem(this.bot, args.item)
    const recipes = this.bot.recipesAll(item.id, null, true) || []
    const result = []
    const seen = new Set()
    for (const recipe of recipes) {
      if (!recipe || !recipe.result) continue
      const resultItem = this.bot.registry.items[recipe.result.id]
      if (!resultItem) continue
      const ingredients = new Map()
      if (Array.isArray(recipe.delta) && recipe.delta.length > 0) {
        for (const delta of recipe.delta) {
          if (!delta || delta.count >= 0) continue
          const ingredient = this.bot.registry.items[delta.id]
          if (!ingredient) continue
          const name = canonicalName(ingredient.name)
          ingredients.set(name, (ingredients.get(name) || 0) + Math.abs(delta.count))
        }
      } else {
        const slots = []
        if (Array.isArray(recipe.inShape)) {
          for (const row of recipe.inShape) {
            if (Array.isArray(row)) slots.push(...row)
          }
        }
        if (Array.isArray(recipe.ingredients)) slots.push(...recipe.ingredients)
        for (const entry of slots) {
          const id = typeof entry === 'object' && entry !== null ? entry.id : entry
          if (!id || id === -1) continue
          const ingredient = this.bot.registry.items[id]
          if (!ingredient) continue
          const name = canonicalName(ingredient.name)
          const count = typeof entry === 'object' && entry.count ? entry.count : 1
          ingredients.set(name, (ingredients.get(name) || 0) + count)
        }
      }
      const payload = {
        result: { name: canonicalName(resultItem.name), count: recipe.result.count || 1 },
        ingredients: [...ingredients.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, count]) => ({ name, count })),
        requires_table: Boolean(recipe.requiresTable)
      }
      const key = JSON.stringify(payload)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(payload)
      if (result.length >= 64) break
    }
    return {
      recipes: result,
      observed_at: nowIso(),
      world_id: this.worldId()
    }
  }

  _act (args) {
    if (this.inspecting) throw new BusyError(null)
    const runner = getRunner(args.kind)
    const timeoutMs = timeoutFor(args.kind, args)
    return this.manager.start(args.kind, (ctx) => runner(ctx, args), {
      bot: this.bot,
      timeoutMs
    })
  }

  _actionStatus (args) {
    const status = this.manager.status(args.action_id)
    if (!status) throw new ActionError('ACTION_NOT_FOUND', `No action with id ${args.action_id}`)
    return status
  }

  _stop () {
    if (this.inspectToken) this.inspectToken.cancel('stop')
    const result = this.manager.stop()
    this.interrupt()
    return result
  }

  interrupt () {
    if (!this.bot) return
    stopPathfinding(this.bot)
    try {
      this.bot.stopDigging()
    } catch {
      // nothing being dug
    }
    try {
      this.bot.clearControlStates()
    } catch {
      // ignore
    }
    try {
      const window = this.bot.currentWindow
      if (window) {
        if (typeof window.close === 'function') window.close()
        else this.bot.closeWindow(window)
      }
    } catch {
      // window may already be gone
    }
  }

  _beginShutdown (exitDelayMs) {
    if (this.shuttingDown) return
    this.shuttingDown = true
    try {
      this.manager.stop()
    } catch {
      // ignore
    }
    if (this.inspectToken) this.inspectToken.cancel('stop')
    this.interrupt()
    try {
      if (this.bot) this.bot.quit('shutdown')
    } catch {
      // ignore
    }
    this._scheduleExit(exitDelayMs)
  }

  dispose () {
    this.shuttingDown = true
    try {
      this.manager.stop()
    } catch {
      // ignore
    }
    if (this.inspectToken) this.inspectToken.cancel('stop')
    this.interrupt()
    try {
      if (this.bot) this.bot.end('executor closed')
    } catch {
      // ignore
    }
    this._scheduleExit(100)
  }

  _scheduleExit (delayMs) {
    if (this._exitScheduled) return
    this._exitScheduled = true
    setTimeout(() => this.exit(0), delayMs)
  }
}

module.exports = { BotRuntime, INSPECT_BLOCKS, INSPECT_WINDOW_TYPES }
