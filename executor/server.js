#!/usr/bin/env node
'use strict'

const util = require('node:util')

// stdout is reserved for the JSONL protocol.  Any library that calls console
// must not be able to corrupt it.
for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  console[level] = (...args) => {
    process.stderr.write(`${util.format(...args)}\n`)
  }
}

const { readMinecraftConfig, resolveConfigPath } = require('./lib/config')
const { JsonlTransport } = require('./lib/transport')
const { BotRuntime } = require('./lib/runtime')
const { publicError } = require('./lib/errors')

function parseArgs (argv) {
  let configPath = 'config.json'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config') {
      if (i + 1 >= argv.length) throw new Error('--config requires a path')
      configPath = argv[++i]
    } else if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length)
    } else if (arg === '--help' || arg === '-h') {
      process.stderr.write('usage: node executor/server.js --config config.json\n')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return configPath
}

function log (message) {
  process.stderr.write(`[executor] ${message}\n`)
}

function main () {
  let configPath
  try {
    configPath = resolveConfigPath(parseArgs(process.argv.slice(2)))
  } catch (err) {
    log(err.message)
    process.exit(2)
    return
  }

  let config
  try {
    config = readMinecraftConfig(configPath)
  } catch (err) {
    log(err.message)
    process.exit(2)
    return
  }

  let transport
  let runtime
  try {
    transport = new JsonlTransport({
      onRequest: async (request) => {
        const id = request && typeof request.id === 'string' ? request.id : null
        try {
          const result = await runtime.handle(request)
          if (id) transport.respond(id, true, result)
        } catch (err) {
          const publicErr = publicError(err)
          if (id) {
            transport.respond(id, false, publicErr)
          } else {
            transport.event('error', publicErr)
          }
          if (publicErr.code === 'INTERNAL_ERROR') {
            log(`request failed: ${err && err.stack ? err.stack : err}`)
          }
        }
      },
      onClose: () => {
        runtime.dispose()
      },
      logger: log
    })

    runtime = new BotRuntime({
      config,
      sendEvent: (name, data) => transport.event(name, data),
      logger: log
    })
  } catch (err) {
    log(err && err.stack ? err.stack : String(err))
    process.exit(1)
    return
  }

  process.stdout.on('error', (err) => {
    log(`stdout error: ${err.message}`)
    process.exit(1)
  })

  transport.start()
  runtime.connect().catch(() => {
    // The error event has already been emitted; the process stays up so that
    // the parent can request shutdown or close stdin.  It never reconnects.
  })

  const shutdown = (signal) => {
    log(`received ${signal}, shutting down`)
    runtime.dispose()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  process.on('uncaughtException', (err) => {
    log(`uncaught exception: ${err && err.stack ? err.stack : err}`)
    try {
      transport.event('error', { code: 'INTERNAL_ERROR', message: err.message || 'Uncaught exception' })
    } catch {
      // ignore
    }
    runtime.dispose()
  })
  process.on('unhandledRejection', (err) => {
    log(`unhandled rejection: ${err && err.stack ? err.stack : err}`)
    try {
      transport.event('error', { code: 'INTERNAL_ERROR', message: (err && err.message) || 'Unhandled rejection' })
    } catch {
      // ignore
    }
  })
}

main()
