'use strict'

const fs = require('node:fs')
const path = require('node:path')

const USERNAME = /^[A-Za-z0-9_]{1,16}$/

function fail (field, message) {
  const err = new Error(`Invalid config ${field}: ${message}`)
  err.code = 'INVALID_CONFIG'
  err.field = field
  throw err
}

function readMinecraftConfig (file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    const wrapped = new Error(`Cannot read config file ${file}: ${err.message}`)
    wrapped.code = 'INVALID_CONFIG'
    throw wrapped
  }
  let root
  try {
    root = JSON.parse(raw)
  } catch (err) {
    const wrapped = new Error(`Config file ${file} is not valid JSON: ${err.message}`)
    wrapped.code = 'INVALID_CONFIG'
    throw wrapped
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) fail('root', 'must be a JSON object')
  const mc = root.minecraft
  if (!mc || typeof mc !== 'object' || Array.isArray(mc)) fail('minecraft', 'must be an object')

  if (typeof mc.host !== 'string' || mc.host.length === 0 || mc.host.length > 255) {
    fail('minecraft.host', 'must be a non-empty string')
  }
  if (!Number.isInteger(mc.port) || mc.port < 1 || mc.port > 65535) {
    fail('minecraft.port', 'must be an integer between 1 and 65535')
  }
  if (typeof mc.version !== 'string' || mc.version.length === 0) {
    fail('minecraft.version', 'must be a non-empty string')
  }
  if (typeof mc.username !== 'string' || !USERNAME.test(mc.username)) {
    fail('minecraft.username', 'must be a plain Minecraft username')
  }
  if (mc.auth !== 'offline') {
    fail('minecraft.auth', 'only "offline" is supported by this executor')
  }
  if (typeof mc.world_id !== 'string' || mc.world_id.length === 0 || mc.world_id.length > 128) {
    fail('minecraft.world_id', 'must be a non-empty string of at most 128 characters')
  }

  // Only the minecraft block is retained.  Model keys, key-file paths, and any
  // other configuration are deliberately not loaded by the executor.
  return {
    host: mc.host,
    port: mc.port,
    version: mc.version,
    username: mc.username,
    auth: mc.auth,
    world_id: mc.world_id
  }
}

function resolveConfigPath (argPath, cwd = process.cwd()) {
  return path.resolve(cwd, argPath || 'config.json')
}

module.exports = { readMinecraftConfig, resolveConfigPath }
