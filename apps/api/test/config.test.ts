import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, loadConfig, loadMigrationConfig, readSecret } from '../config.ts'
import { AUTH_ENV, DB_ENV, secretFile, SERVER_ENV, TENANT_ID } from './helpers/env.ts'

const base = SERVER_ENV
const valid = { ...base, PUBLIC_URL: 'https://wahl.example.org' }

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

test('PUBLIC_URL is required, and every problem is named in one message', () => {
  const message = problem({ PORT: 'x', LOG_LEVEL: 'loud' })
  assert.match(message, /PUBLIC_URL must be set/)
  assert.match(message, /PORT must be an integer/)
  assert.match(message, /LOG_LEVEL must be info, warn or error/)
})

test('PUBLIC_URL must be https, except on loopback', () => {
  assert.match(problem({ ...base, PUBLIC_URL: 'http://wahl.example.org' }), /must use https/)
  assert.match(problem({ ...base, PUBLIC_URL: 'http://10.0.0.5:3000' }), /must use https/)
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://wahl.example.org:8443']) {
    assert.equal(loadConfig({ ...base, PUBLIC_URL: origin }).publicOrigin, new URL(origin).origin)
  }
})

test('PUBLIC_URL is an origin, or an origin with a path of plain segments, and nothing else', () => {
  for (const value of ['https://wahl.example.org/?a=1', 'https://wahl.example.org/wahl?', 'https://wahl.example.org/wahl#x', 'https://user:pw@wahl.example.org', 'wahl.example.org', 'ftp://wahl.example.org',
    'https://www.example.org/wahl//', 'https://www.example.org/wahl%20x', 'https://www.example.org/v1.2']) {
    assert.throws(() => loadConfig({ ...base, PUBLIC_URL: value }), ConfigError, value)
  }
  const root = loadConfig({ ...base, PUBLIC_URL: 'https://wahl.example.org/' })
  assert.deepEqual([root.publicUrl, root.publicOrigin, root.basePath], ['https://wahl.example.org', 'https://wahl.example.org', ''])
  for (const value of ['https://www.example.org/wahl', 'https://www.example.org/wahl/']) {
    const under = loadConfig({ ...base, PUBLIC_URL: value })
    assert.deepEqual([under.publicUrl, under.publicOrigin, under.basePath], ['https://www.example.org/wahl', 'https://www.example.org', '/wahl'], value)
  }
  assert.equal(loadConfig({ ...base, PUBLIC_URL: 'https://www.example.org/schule/wahl-2026' }).basePath, '/schule/wahl-2026')
  assert.equal(loadConfig({ ...base, PUBLIC_URL: 'http://localhost:5173/wahl' }).publicUrl, 'http://localhost:5173/wahl')
})

test('PUBLIC_ORIGIN, the setting\'s earlier name, is refused by name', () => {
  assert.match(problem({ ...valid, PUBLIC_ORIGIN: 'https://wahl.example.org' }), /PUBLIC_ORIGIN is no longer read; set PUBLIC_URL/)
})

test('TRUST_PROXY takes addresses and CIDRs only', () => {
  assert.deepEqual(loadConfig({ ...valid, TRUST_PROXY: '10.0.2.2, 192.168.0.0/16,::1' }).trustProxy, ['10.0.2.2', '192.168.0.0/16', '::1'])
  for (const value of ['true', '*', '1', 'proxy.local', '10.0.0.0/33', '10.0.0.1/8/1', '::1/129']) {
    assert.match(problem({ ...valid, TRUST_PROXY: value }), /TRUST_PROXY/, value)
  }
})

test('debug logging is refused unless both the origin and the listening address are loopback', () => {
  assert.match(problem({ ...valid, LOG_LEVEL: 'debug' }), /LOG_LEVEL=debug is allowed only with a loopback PUBLIC_URL and HOST/)
  assert.match(problem({ ...valid, LOG_LEVEL: 'trace' }), /LOG_LEVEL=trace/)
  for (const HOST of ['0.0.0.0', '::', '192.168.1.10']) {
    assert.match(problem({ ...base, PUBLIC_URL: 'http://localhost:5173', HOST, LOG_LEVEL: 'debug' }), /LOG_LEVEL=debug/, HOST)
  }
  assert.equal(loadConfig({ ...base, PUBLIC_URL: 'http://localhost:5173', LOG_LEVEL: 'debug' }).logLevel, 'debug')
  assert.equal(loadConfig({ ...base, PUBLIC_URL: 'http://localhost:5173', HOST: '::1', LOG_LEVEL: 'trace' }).logLevel, 'trace')
  assert.equal(loadConfig({ ...valid, LOG_LEVEL: 'warn' }).logLevel, 'warn')
})

test('PORT must be a valid port', () => {
  for (const port of ['0', '65536', '3000.5', '-1', 'abc']) assert.match(problem({ ...valid, PORT: port }), /PORT/, port)
  assert.equal(loadConfig({ ...valid, PORT: '8080' }).port, 8080)
})

test('NODE_ENV changes none of these outcomes', () => {
  const cases: Record<string, string>[] = [
    valid,
    { ...base, PUBLIC_URL: 'http://wahl.example.org' },
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

test('the runtime database password comes from a file, never from the URL', () => {
  assert.equal(loadConfig(valid).databaseUrl, 'postgres://school_election_app:test-password@127.0.0.1:5432/school_election')
  assert.match(problem({ ...valid, DATABASE_URL: 'postgres://school_election_app:inline@127.0.0.1/school_election' }), /DATABASE_URL must not contain a password/)
  assert.match(problem({ ...valid, DATABASE_PASSWORD: 'inline' }), /DATABASE_PASSWORD must not be set/)
  assert.match(problem({ PUBLIC_URL: valid.PUBLIC_URL }), /DATABASE_URL must be set/)
  for (const url of ['mysql://u@h/db', 'postgres://127.0.0.1/db', 'postgres://u@127.0.0.1/', 'not a url']) {
    assert.match(problem({ ...valid, DATABASE_URL: url }), /DATABASE_URL/, url)
  }
  // Query parameters override the URL in the driver.
  for (const query of ['password=inline', 'user=postgres', 'options=-c%20log_statement%3Dall', 'host=evil.example', 'sslmode=require&user=postgres']) {
    assert.match(problem({ ...valid, DATABASE_URL: `${DB_ENV.DATABASE_URL}?${query}` }), /may carry no query parameters except sslmode/, query)
  }
  assert.match(problem({ ...valid, DATABASE_URL: `${DB_ENV.DATABASE_URL}#x` }), /no query parameters except sslmode, got a fragment/)
  for (const url of ['postgres://bad%zz@127.0.0.1/school_election', 'postgres://app@127.0.0.1/db%e0']) {
    assert.match(problem({ ...valid, DATABASE_URL: url }), /malformed percent escape/, url)
  }
  assert.match(loadConfig({ ...valid, DATABASE_URL: `${DB_ENV.DATABASE_URL}?sslmode=require` }).databaseUrl, /\?sslmode=require$/)
})

test('a password with special characters is encoded into the URL', () => {
  for (const password of ['p@ss:w/rd%', '%25', 'a b#c?d', 'ü€']) {
    const env = { ...valid, DATABASE_PASSWORD_FILE: secretFile('special', `${password}\n`) }
    assert.equal(decodeURIComponent(new URL(loadConfig(env).databaseUrl).password), password)
  }
})

test('the migrator reads its owner URL and both passwords from their own variables', () => {
  const env = {
    MIGRATION_DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/school_election',
    MIGRATION_DATABASE_PASSWORD_FILE: secretFile('owner', 'owner-pw'),
    DB_RUNTIME_PASSWORD_FILE: secretFile('runtime', 'runtime-pw'),
  }
  assert.deepEqual(loadMigrationConfig(env), {
    databaseUrl: 'postgres://postgres:owner-pw@127.0.0.1:5432/school_election',
    runtimePassword: 'runtime-pw',
  })
  assert.throws(() => loadMigrationConfig({ ...env, DB_RUNTIME_PASSWORD: 'inline' }), /DB_RUNTIME_PASSWORD must not be set/)
  for (const password of ['pässwort', 'tab\there', 'emoji🙂']) {
    assert.throws(
      () => loadMigrationConfig({ ...env, DB_RUNTIME_PASSWORD_FILE: secretFile('non-ascii', password) }),
      /DB_RUNTIME_PASSWORD_FILE must contain printable ASCII characters only/,
      password,
    )
  }
  assert.throws(() => loadMigrationConfig({}), /MIGRATION_DATABASE_URL must be set[\s\S]*DB_RUNTIME_PASSWORD_FILE must be set/)
})

test('the Entra and session settings are mandatory, and each missing one is named', () => {
  const config = loadConfig(valid)
  assert.deepEqual(config.entra, { tenantId: TENANT_ID, clientId: AUTH_ENV.ENTRA_CLIENT_ID, clientSecret: 'test~client.secret_value' })
  assert.equal(config.sessionSecret.length, 32)
  const message = problem({ ...DB_ENV, PUBLIC_URL: valid.PUBLIC_URL })
  for (const name of ['ENTRA_TENANT_ID must be set', 'ENTRA_CLIENT_ID must be set', 'ENTRA_CLIENT_SECRET_FILE must be set', 'SESSION_KEY_FILE must be set']) {
    assert.ok(message.includes(name), name)
  }
  assert.match(problem({ ...valid, ENTRA_CLIENT_SECRET: 'inline' }), /ENTRA_CLIENT_SECRET must not be set/)
  assert.match(problem({ ...valid, SESSION_KEY: 'inline' }), /SESSION_KEY must not be set/)
})

test('the tenant and client are GUIDs: one tenant, never "common" or a domain', () => {
  for (const value of ['common', 'organizations', 'consumers', 'schule.example.org', '3f2b8c1d6e4a4b7f9c2d8a1e5f6b7c90']) {
    assert.match(problem({ ...valid, ENTRA_TENANT_ID: value }), /ENTRA_TENANT_ID must be a GUID/, value)
    assert.match(problem({ ...valid, ENTRA_CLIENT_ID: value }), /ENTRA_CLIENT_ID must be a GUID/, value)
  }
  assert.equal(loadConfig({ ...valid, ENTRA_TENANT_ID: TENANT_ID.toUpperCase() }).entra.tenantId, TENANT_ID)
})

test('the session key holds at least 32 random bytes in hex', () => {
  for (const content of ['too short', 'ab'.repeat(31), 'zz'.repeat(32), 'a'.repeat(63)]) {
    assert.match(problem({ ...valid, SESSION_KEY_FILE: secretFile('bad-session-key', content) }), /SESSION_KEY_FILE must hold at least 32 random bytes/, content)
  }
  assert.equal(loadConfig({ ...valid, SESSION_KEY_FILE: secretFile('long-session-key', 'AB'.repeat(48)) }).sessionSecret.length, 48)
})

test('the client secret must be printable ASCII', () => {
  assert.match(problem({ ...valid, ENTRA_CLIENT_SECRET_FILE: secretFile('bad-client-secret', 'gehëim') }), /ENTRA_CLIENT_SECRET_FILE must contain printable ASCII/)
})

test('DEBUG, which makes dependencies print to stderr, is refused outside local development', () => {
  assert.match(problem({ ...valid, DEBUG: 'simple-oauth2:*' }), /DEBUG is allowed only with a loopback PUBLIC_URL and HOST/)
  assert.match(problem({ ...base, PUBLIC_URL: 'http://localhost:5173', HOST: '0.0.0.0', DEBUG: '*' }), /DEBUG/)
  assert.doesNotThrow(() => loadConfig({ ...base, PUBLIC_URL: 'http://localhost:5173', DEBUG: '*' }))
  assert.doesNotThrow(() => loadConfig({ ...valid, DEBUG: ' ' }))
})

test('the build metadata from the image is exposed, with defaults outside an image', () => {
  assert.deepEqual(loadConfig(valid).build, { version: 'dev', gitSha: 'unknown' })
  const sha = 'c7f5b77e0a1b2c3d4e5f60718293a4b5c6d7e8f9'
  assert.deepEqual(loadConfig({ ...valid, APP_VERSION: 'v1.2.0', GIT_SHA: sha }).build, { version: 'v1.2.0', gitSha: sha })
  assert.deepEqual(loadConfig({ ...valid, APP_VERSION: ' ', GIT_SHA: '' }).build, { version: 'dev', gitSha: 'unknown' })
  for (const value of ['-v1', 'v1 2', 'v1;rm', '<b>', 'x'.repeat(65)]) {
    assert.match(problem({ ...valid, APP_VERSION: value }), /APP_VERSION must be a release tag/, value)
  }
  for (const value of ['C7F5B77', 'c7f5b7', 'main', `${sha}z`]) {
    assert.match(problem({ ...valid, GIT_SHA: value }), /GIT_SHA must be a commit hash/, value)
  }
})
