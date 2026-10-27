'use strict'

const readline = require('node:readline')

/**
 * UTF-8 JSONL transport.  stdout carries protocol responses/events only;
 * diagnostics are written to stderr by the caller's logger.
 */
class JsonlTransport {
  constructor ({ input = process.stdin, output = process.stdout, onRequest, onClose, logger } = {}) {
    this.input = input
    this.output = output
    this.onRequest = onRequest
    this.onClose = onClose
    this.logger = logger || (() => {})
    this.closed = false
    this.rl = null
  }

  start () {
    this.rl = readline.createInterface({ input: this.input, crlfDelay: Infinity })
    this.rl.on('line', (line) => this._onLine(line))
    this.rl.on('close', () => {
      this.closed = true
      if (this.onClose) this.onClose()
    })
    this.input.on('error', (err) => this.logger(`stdin error: ${err.message}`))
  }

  _onLine (line) {
    if (this.closed) return
    if (line.trim() === '') return
    let request
    try {
      request = JSON.parse(line)
    } catch (err) {
      this.event('error', { code: 'BAD_JSON', message: `Invalid JSON request: ${err.message}` })
      return
    }
    if (!this.onRequest) return
    Promise.resolve()
      .then(() => this.onRequest(request))
      .catch((err) => {
        this.logger(`request handler failed: ${err && err.stack ? err.stack : err}`)
      })
  }

  respond (id, ok, payload) {
    const message = { id, ok }
    if (ok) {
      message.result = payload === undefined ? {} : payload
    } else {
      message.error = payload || { code: 'INTERNAL_ERROR', message: 'Unknown error' }
    }
    this.send(message)
  }

  event (name, data) {
    this.send({ event: name, data: data === undefined ? {} : data })
  }

  send (message) {
    if (this.closed) return false
    let line
    try {
      line = JSON.stringify(message)
    } catch (err) {
      this.logger(`could not serialize protocol message: ${err.message}`)
      return false
    }
    try {
      return this.output.write(`${line}\n`)
    } catch (err) {
      this.logger(`stdout write failed: ${err.message}`)
      return false
    }
  }

  close () {
    this.closed = true
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
  }
}

module.exports = { JsonlTransport }
