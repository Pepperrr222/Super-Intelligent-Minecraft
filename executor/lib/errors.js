'use strict'

class AgentError extends Error {
  constructor (code, message, details) {
    super(message)
    this.name = 'AgentError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

class ValidationError extends AgentError {
  constructor (message, field) {
    super('INVALID_ARGS', message)
    this.name = 'ValidationError'
    if (field !== undefined) this.field = field
  }
}

class ActionError extends AgentError {
  constructor (code, message, details) {
    super(code, message, details)
    this.name = 'ActionError'
  }
}

class CancelledError extends AgentError {
  constructor (reason, message) {
    super(reason === 'timeout' ? 'ACTION_TIMEOUT' : 'ACTION_CANCELLED',
      message || (reason === 'timeout' ? 'Action timed out' : 'Action cancelled'))
    this.name = 'CancelledError'
    this.reason = reason
  }
}

class BusyError extends AgentError {
  constructor (actionId) {
    super('BUSY', 'Another mutation action is still running or settling')
    this.name = 'BusyError'
    if (actionId) this.action_id = actionId
  }
}

function publicError (err) {
  if (err instanceof AgentError) {
    const out = { code: err.code, message: err.message }
    if (err.field !== undefined) out.field = err.field
    return out
  }
  return {
    code: 'INTERNAL_ERROR',
    message: (err && typeof err.message === 'string' && err.message) || 'Internal executor error'
  }
}

module.exports = {
  AgentError,
  ValidationError,
  ActionError,
  CancelledError,
  BusyError,
  publicError
}
