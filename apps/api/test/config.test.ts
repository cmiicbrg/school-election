import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, loadConfig, readSecret } from '../config.ts'

const valid = { PUBLIC_ORIGIN: 'https://wahl.example.org' }

function problem(env: Record<string, string>): string {
  try {
    loadConfig(env)
  } catch (err) {
    assert.ok(err instanceof ConfigError)
    return err.message
  }
  assert.fail(`expected ${JSON.stringify(env)} to be rejected`)
}

test('a minimal valid configuration loads with safe defaults', () => {
  const config = loadConfig(valid)
  assert.equal(config.publicOrigin, 'https://wahl.example.org')
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 3000)
  assert.equal(config.logLevel, 'info')
  assert.deepEqual(config.trustProxy, ['127.0.0.0/8', '::1/128'])
})

test('PUBLIC_ORIGIN is required, and every problem is named in one message', () => {
  const message = problem({ PORT: 'x', LOG_LEVEL: 'loud' })
  assert.match(message, /PUBLIC_ORIGIN must be set/)
  assert.match(message, /PORT must be an integer/)
  assert.match(message, /LOG_LEVEL must be info, warn or error/)
})

test('PUBLIC_ORIGIN must be https, except on loopback', () => {
  assert.match(problem({ PUBLIC_ORIGIN: 'http://wahl.example.org' }), /must use https/)
  assert.match(problem({ PUBLIC_ORIGIN: 'http://10.0.0.5:3000' }), /must use https/)
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://wahl.example.org:8443']) {
    assert.equal(loadConfig({ PUBLIC_ORIGIN: origin }).publicOrigin, new URL(origin).origin)
  }
})

test('PUBLIC_ORIGIN must be a bare origin', () => {
  for (const origin of ['https://wahl.example.org/app', 'https://wahl.example.org/?a=1', 'https://user:pw@wahl.example.org', 'wahl.example.org', 'ftp://wahl.example.org']) {
    assert.throws(() => loadConfig({ PUBLIC_ORIGIN: origin }), ConfigError, origin)
  }
  assert.equal(loadConfig({ PUBLIC_ORIGIN: 'https://wahl.example.org/' }).publicOrigin, 'https://wahl.example.org')
})

test('TRUST_PROXY takes addresses and CIDRs only', () => {
  assert.deepEqual(loadConfig({ ...valid, TRUST_PROXY: '10.0.2.2, 192.168.0.0/16,::1' }).trustProxy, ['10.0.2.2', '192.168.0.0/16', '::1'])
  for (const value of ['true', '*', '1', 'proxy.local', '10.0.0.0/33', '10.0.0.1/8/1', '::1/129']) {
    assert.match(problem({ ...valid, TRUST_PROXY: value }), /TRUST_PROXY/, value)
  }
})

test('debug logging is refused unless both the origin and the listening address are loopback', () => {
  assert.match(problem({ ...valid, LOG_LEVEL: 'debug' }), /LOG_LEVEL=debug is allowed only with a loopback PUBLIC_ORIGIN and HOST/)
  assert.match(problem({ ...valid, LOG_LEVEL: 'trace' }), /LOG_LEVEL=trace/)
  for (const HOST of ['0.0.0.0', '::', '192.168.1.10']) {
    assert.match(problem({ PUBLIC_ORIGIN: 'http://localhost:5173', HOST, LOG_LEVEL: 'debug' }), /LOG_LEVEL=debug/, HOST)
  }
  assert.equal(loadConfig({ PUBLIC_ORIGIN: 'http://localhost:5173', LOG_LEVEL: 'debug' }).logLevel, 'debug')
  assert.equal(loadConfig({ PUBLIC_ORIGIN: 'http://localhost:5173', HOST: '::1', LOG_LEVEL: 'trace' }).logLevel, 'trace')
  assert.equal(loadConfig({ ...valid, LOG_LEVEL: 'warn' }).logLevel, 'warn')
})

test('PORT must be a valid port', () => {
  for (const port of ['0', '65536', '3000.5', '-1', 'abc']) assert.match(problem({ ...valid, PORT: port }), /PORT/, port)
  assert.equal(loadConfig({ ...valid, PORT: '8080' }).port, 8080)
})

test('NODE_ENV changes none of these outcomes', () => {
  const cases: Record<string, string>[] = [
    valid,
    { PUBLIC_ORIGIN: 'http://wahl.example.org' },
    { ...valid, LOG_LEVEL: 'debug' },
    { ...valid, TRUST_PROXY: 'true' },
    {},
  ]
  for (const env of cases) {
    const outcomes = ['production', 'development', 'test', undefined].map((NODE_ENV) => {
      try {
        return JSON.stringify(loadConfig({ ...env, ...(NODE_ENV ? { NODE_ENV } : {}) }))
      } catch (err) {
        return (err as Error).message
      }
    })
    assert.equal(new Set(outcomes).size, 1, JSON.stringify(env))
  }
})

test('secrets come from *_FILE only, trimmed, never from an inline variable', () => {
  const files: Record<string, string> = { '/run/secrets/key': '  s3cret\n', '/run/secrets/empty': ' \n' }
  const readFile = (file: string) => {
    const content = files[file]
    if (content === undefined) throw new Error('ENOENT')
    return content
  }
  assert.equal(readSecret({ SESSION_KEY_FILE: '/run/secrets/key' }, 'SESSION_KEY', readFile), 's3cret')
  assert.throws(() => readSecret({ SESSION_KEY: 's3cret' }, 'SESSION_KEY', readFile), /SESSION_KEY must not be set/)
  assert.throws(() => readSecret({ SESSION_KEY: 's3cret', SESSION_KEY_FILE: '/run/secrets/key' }, 'SESSION_KEY', readFile), /must not be set/)
  assert.throws(() => readSecret({}, 'SESSION_KEY', readFile), /SESSION_KEY_FILE must be set/)
  assert.throws(() => readSecret({ SESSION_KEY_FILE: '/missing' }, 'SESSION_KEY', readFile), /cannot read \/missing/)
  assert.throws(() => readSecret({ SESSION_KEY_FILE: '/run/secrets/empty' }, 'SESSION_KEY', readFile), /is empty/)
})
