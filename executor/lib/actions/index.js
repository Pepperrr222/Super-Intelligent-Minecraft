'use strict'

const gotoAction = require('./goto')
const followAction = require('./follow')
const collectAction = require('./collect')
const craftAction = require('./craft')
const transferAction = require('./transfer')
const smeltAction = require('./smelt')
const placeAction = require('./place')
const { DEFAULT_TIMEOUT_MS, HARD_MAX_TIMEOUT_MS } = require('../action-manager')

const RUNNERS = {
  goto: gotoAction,
  follow: followAction,
  collect: collectAction,
  craft: craftAction,
  deposit: transferAction,
  withdraw: transferAction,
  smelt: smeltAction,
  place: placeAction
}

function getRunner (kind) {
  const runner = RUNNERS[kind]
  if (!runner) throw new Error(`No action runner registered for ${kind}`)
  return runner.run
}

function timeoutFor (kind, args) {
  let timeout = DEFAULT_TIMEOUT_MS
  if (kind === 'follow') {
    timeout = Math.min(DEFAULT_TIMEOUT_MS, (args.duration_seconds + 15) * 1000)
  } else if (kind === 'smelt') {
    // wait_seconds is an explicit upper bound.  A legal 120s wait cannot fit
    // in exactly 120s once insertion/retrieval is included, so allow a small
    // fixed grace period, still under the hard manager ceiling.
    timeout = Math.min(HARD_MAX_TIMEOUT_MS, args.wait_seconds * 1000 + 20000)
  }
  return Math.floor(timeout)
}

module.exports = { getRunner, timeoutFor, RUNNERS }
