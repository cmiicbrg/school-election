import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../lib/db.ts'
import { checkDatabaseSettings, REQUIRED_SETTINGS } from '../../lib/db-settings.ts'
import { sqlState } from '../../lib/pg-errors.ts'
import { migrate, MIGRATIONS_DIR } from '../../scripts/migrate.ts'
import { createTestDatabase, DB, TEST_RUNTIME_PASSWORD, withClient } from '../helpers/db.ts'

const safe: Record<string, string> = {
  ...Object.fromEntries(REQUIRED_SETTINGS.map((s) => [s.name, s.expected])),
  log_min_messages: 'warning',
  log_destination: 'stderr',
  shared_preload_libraries: '',
  session_preload_libraries: '',
  local_preload_libraries: '',
}

function serverWith(overrides: Record<string, string>, role = 'school_election_app') {
  const values = { ...safe, ...overrides }
  const answer = (text: string, params?: unknown[]) => {
    if (text.includes('current_user')) return { rows: [{ name: role }] }
    if (text.includes('preload_settings()')) {
      return { rows: ['shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries'].map((name) => ({ name, setting: values[name] ?? '' })) }
    }
    return { rows: (params?.[0] as string[]).map((name) => ({ name, value: values[name] ?? '' })) }
  }
  return { query: (text: string, params?: unknown[]) => Promise.resolve(answer(text, params)) } as never
}

test('safe settings pass', async () => {
  assert.deepEqual(await checkDatabaseSettings(serverWith({})), [])
})

// An unsafe value for every required setting, derived from the list itself,
// so a setting added to the check is tested without anyone remembering to.
const UNSAFE: Record<string, string> = { 'off': 'on', 'none': 'all', 'terse': 'default', 'panic': 'error', '0': '1', '-1': '0' }

test('every required setting is checked: a single unsafe value is named, whatever NODE_ENV says', async () => {
  for (const NODE_ENV of ['production', 'development']) {
    process.env.NODE_ENV = NODE_ENV
    for (const [name, value] of [
      ...REQUIRED_SETTINGS.map((s) => [s.name, UNSAFE[s.expected] ?? `not-${s.expected}`] as const),
      ['wal_keep_size', '1GB'],
      ['archive_mode', 'always'],
    ] as const) {
      const problems = await checkDatabaseSettings(serverWith({ [name]: value }))
      assert.equal(problems.length, 1, name)
      assert.match(problems[0] ?? '', new RegExp(`^${name} is ${value}, must be`))
    }
  }
  delete process.env.NODE_ENV
})

test('debug message levels and csv or json logs are refused', async () => {
  for (const [name, value] of [
    ['log_min_messages', 'debug2'],
    ['log_min_messages', 'debug5'],
    ['log_destination', 'jsonlog'],
    ['log_destination', 'stderr,csvlog'],
  ] as const) {
    const problems = await checkDatabaseSettings(serverWith({ [name]: value }))
    assert.equal(problems.length, 1, value)
    assert.match(problems[0] ?? '', new RegExp(`^${name} is ${value}, must be one of`))
  }
  for (const [name, value] of [['log_min_messages', 'error'], ['log_min_messages', 'PANIC'], ['log_destination', 'syslog'], ['log_destination', 'stderr, syslog']] as const) {
    assert.deepEqual(await checkDatabaseSettings(serverWith({ [name]: value })), [], value)
  }
})

test('only pg_stat_statements may be preloaded', async () => {
  for (const name of ['shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries']) {
    for (const [value, reported] of [
      ['auto_explain', 'auto_explain'],
      ['auto_explain.so', 'auto_explain'],
      ['$libdir/auto_explain.so', 'auto_explain'],
      ['pgaudit', 'pgaudit'],
      ['pg_stat_statements, auto_explain', 'auto_explain'],
      ['"$libdir/plugins/pgaudit"', 'pgaudit'],
    ] as const) {
      const problems = await checkDatabaseSettings(serverWith({ [name]: value }))
      assert.equal(problems.length, 1, value)
      assert.match(problems[0] ?? '', new RegExp(`^${name} loads ${reported}; only pg_stat_statements may be preloaded`), value)
    }
  }
  for (const value of ['', 'pg_stat_statements', '$libdir/pg_stat_statements.so']) {
    assert.deepEqual(await checkDatabaseSettings(serverWith({ shared_preload_libraries: value })), [], value)
  }
})

test('any role but the runtime role is refused, before anything else is read', async () => {
  // The superuser, the database owner, or any other role a connection string may name by mistake.
  for (const role of ['postgres', 'school_election', 'reporting']) {
    assert.deepEqual(await checkDatabaseSettings(serverWith({ log_statement: 'all' }, role)), [
      `the server connects as ${role}; it must connect as school_election_app`,
    ], role)
  }
})

test('a per-role override on the server is caught, because the check runs as the runtime role', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  // Scoped to this test database, so no other test sees it.
  await withClient(testDb.ownerUrl, (client) => client.query(`alter role school_election_app in database ${testDb.name} set log_min_error_statement = 'error'`))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  assert.deepEqual(await checkDatabaseSettings(db), [
    'log_min_error_statement is error, must be panic: any other value would let the server log statements or their parameters',
  ])
})

test('connecting as the owner superuser is refused', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  const db = createDatabase(testDb.ownerUrl, () => {})
  t.after(() => db.close())
  assert.deepEqual(await checkDatabaseSettings(db), ['the server connects as postgres; it must connect as school_election_app'])
})

test('pg_read_all_settings, granted by earlier versions, is taken back once a run succeeds', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  const admin = process.env.TEST_DATABASE_URL ?? ''
  // Cluster-wide; the run below takes it back, and so does the clean-up if it fails first.
  await withClient(admin, (c) => c.query('grant pg_read_all_settings to school_election_app'))
  t.after(() => withClient(admin, (c) => c.query('revoke pg_read_all_settings from school_election_app')).catch(() => {}))
  const member = async () => (await withClient(admin, (c) => c.query<{ member: boolean }>(
    'select pg_has_role(\'school_election_app\', \'pg_read_all_settings\', \'MEMBER\') as member',
  ))).rows[0]?.member
  // A run whose migration fails keeps it: the server still deployed may need it to restart.
  const failing = await mkdtemp(path.join(tmpdir(), 'school-election-migrations-'))
  await cp(MIGRATIONS_DIR, failing, { recursive: true })
  await writeFile(path.join(failing, '9001_broken.sql'), 'select 1/0;')
  await assert.rejects(migrate({ databaseUrl: testDb.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD, migrationsDir: failing }), /9001_broken.sql failed/)
  assert.equal(await member(), true)
  await migrate({ databaseUrl: testDb.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD })
  assert.equal(await member(), false)
})

test('the runtime role reads the hidden preload settings only through preload_settings()', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  await withClient(testDb.runtimeUrl, async (c) => {
    await assert.rejects(c.query('select current_setting(\'shared_preload_libraries\')'), (err) => sqlState(err) === '42501')
    const { rows } = await c.query<{ name: string }>('select name from preload_settings() order by name')
    assert.deepEqual(rows.map((row) => row.name), ['local_preload_libraries', 'session_preload_libraries', 'shared_preload_libraries'])
  })
  // Nobody else may call it.
  await withClient(testDb.ownerUrl, (c) => c.query('create role se_probe nologin'))
  t.after(() => withClient(process.env.TEST_DATABASE_URL ?? '', (c) => c.query('drop role if exists se_probe')))
  const { rows } = await withClient(testDb.ownerUrl, (c) => c.query<{ allowed: boolean }>('select has_function_privilege(\'se_probe\', \'preload_settings()\', \'EXECUTE\') as allowed'))
  assert.equal(rows[0]?.allowed, false)
})

test('the server pins search_path to public, whatever the role or database sets', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  await withClient(testDb.ownerUrl, (c) => c.query(`alter role school_election_app in database ${testDb.name} set search_path = elsewhere`))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  const { rows } = await db.query<{ search_path: string }>('show search_path')
  assert.equal(rows[0]?.search_path, 'public')
})

test('the test server passes the check on the runtime connection', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  assert.deepEqual(await checkDatabaseSettings(db), [])
})
