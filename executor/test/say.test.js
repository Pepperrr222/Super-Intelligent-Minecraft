'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { sendSay, validateSayMessage } = require('../lib/say')
const { ValidationError } = require('../lib/errors')

test('valid chat is sent verbatim', async () => {
  const sent = []
  const bot = { entity: {}, chat: (message) => sent.push(message) }
  const result = await sendSay(bot, 'hello from the agent')
  assert.deepEqual(result, { sent: true })
  assert.deepEqual(sent, ['hello from the agent'])
})

test('slash commands are rejected before touching the bot', async () => {
  let called = false
  const bot = { entity: {}, chat: () => { called = true } }
  await assert.rejects(sendSay(bot, '/give @p diamond 64'), (err) => {
    assert.ok(err instanceof ValidationError)
    assert.equal(err.field, 'message')
    return true
  })
  assert.equal(called, false)
})

test('message length and control characters are rejected', () => {
  assert.throws(() => validateSayMessage('x'.repeat(201)), ValidationError)
  assert.throws(() => validateSayMessage('a\nb'), ValidationError)
  assert.throws(() => validateSayMessage('a\u0000b'), ValidationError)
  assert.throws(() => validateSayMessage(''), ValidationError)
  assert.throws(() => validateSayMessage(null), ValidationError)
})

test('saying while disconnected fails without sending', async () => {
  await assert.rejects(sendSay(null, 'hello'), (err) => err.code === 'NOT_CONNECTED')
  await assert.rejects(sendSay({}, 'hello'), (err) => err.code === 'NOT_CONNECTED')
})
