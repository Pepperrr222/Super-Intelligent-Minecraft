'use strict'

const { ValidationError, ActionError } = require('./errors')

const MAX_CHAT_LENGTH = 200

/**
 * Chat is deliberately narrow: no slash commands (the server would treat them
 * as commands), no line breaks or other control characters, and a hard length
 * limit so the executor can never smuggle a multi-line protocol command.
 */
function validateSayMessage (value) {
  if (typeof value !== 'string') {
    throw new ValidationError('say.message must be a string', 'message')
  }
  if (value.length === 0) {
    throw new ValidationError('say.message must not be empty', 'message')
  }
  if (value.length > MAX_CHAT_LENGTH) {
    throw new ValidationError(`say.message must be at most ${MAX_CHAT_LENGTH} characters`, 'message')
  }
  if (/^[/]/.test(value)) {
    throw new ValidationError('say.message must not start with "/" (commands are not allowed)', 'message')
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError('say.message must not contain control characters or newlines', 'message')
  }
  return value
}

async function sendSay (bot, value, token) {
  const message = validateSayMessage(value)
  if (!bot || !bot.entity) {
    throw new ActionError('NOT_CONNECTED', 'Cannot say while not connected')
  }
  if (token) {
    await token.wait(Promise.resolve())
  }
  try {
    bot.chat(message)
  } catch (err) {
    throw new ActionError('CHAT_FAILED', `Failed to send chat: ${err.message}`)
  }
  return { sent: true }
}

module.exports = { MAX_CHAT_LENGTH, validateSayMessage, sendSay }
