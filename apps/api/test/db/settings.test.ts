import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../../lib/db.ts'
import { checkDatabaseSettings, REQUIRED_SETTINGS } from '../../lib/db-settings.ts'
import { createTestDatabase, dbTest, withClient } from '../helpers/db.ts'

const safe: Record<string, string> = {
  ...Object.fromEntries(REQUIRED_SETTINGS.map((s) => [s.name, s.expected])),
  shared_preload_libraries: '',
  session_preload_libraries: '',
  local_preload_libraries: '',
}

function serverWith(overrides: Record<string, string>) {
  const values = { ...safe, ...overrides }
  return {
    query: async (_text: string, params?: unknown[]) => ({ rows: [{ value: values[String(params?.[0])] ?? '' }] }),
  } as never
}

test('safe settings pass', async () => {
  assert.deepEqual(await checkDatabaseSettings(serverWith({})), [])
})

test('each unsafe setting is named, whatever NODE_ENV says', async () => {
  for (const NODE_ENV of ['production', 'development']) {
    process.env.NODE_ENV = NODE_ENV
    for (const [name, value] of [
      ['track_commit_timestamp', 'on'],
      ['wal_recycle', 'on'],
      ['summarize_wal', 'on'],
      ['wal_keep_size', '1GB'],
      ['archive_mode', 'on'],
      ['log_statement', 'all'],
      ['log_error_verbosity', 'default'],
      ['log_min_error_statement', 'error'],
      ['log_parameter_max_length', '-1'],
      ['log_min_duration_statement', '0'],
      ['log_lock_waits', 'on'],
    ] as const) {
      const problems = await checkDatabaseSettings(serverWith({ [name]: value }))
      assert.equal(problems.length, 1, name)
      assert.match(problems[0] ?? '', new RegExp(`^${name} is ${value}, must be`))
    }
  }
  delete process.env.NODE_ENV
})

test('auto_explain in any preload list is refused', async () => {
  for (const name of ['shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries']) {
    for (const value of ['auto_explain', 'auto_explain.so', '$libdir/auto_explain.so', 'pg_stat_statements, auto_explain', '"$libdir/plugins/auto_explain"']) {
      const problems = await checkDatabaseSettings(serverWith({ [name]: value }))
      assert.deepEqual(problems, [`${name} loads auto_explain, which logs statements with their parameters`], value)
    }
  }
  assert.deepEqual(await checkDatabaseSettings(serverWith({ shared_preload_libraries: 'pg_stat_statements' })), [])
})

test('the development and CI launcher sets every required setting', async () => {
  const script = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../scripts/postgres.sh'), 'utf8')
  for (const { name, expected } of REQUIRED_SETTINGS) {
    assert.match(script, new RegExp(`-c ${name}=${expected.replace('-', '\\-')}\\n`), name)
  }
})

dbTest('a per-role override on the server is caught, because the check runs as the runtime role', async (t) => {
  const testDb = await createTestDatabase(t)
  // Scoped to this test database, so no other test sees it.
  await withClient(testDb.ownerUrl, (client) => client.query(`alter role school_election_app in database ${testDb.name} set log_min_error_statement = 'error'`))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  assert.deepEqual(await checkDatabaseSettings(db), [
    'log_min_error_statement is error, must be panic: any other value would let the server log statements or their parameters',
  ])
})

dbTest('the test server passes the check on the runtime connection', async (t) => {
  const testDb = await createTestDatabase(t)
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  assert.deepEqual(await checkDatabaseSettings(db), [])
})
