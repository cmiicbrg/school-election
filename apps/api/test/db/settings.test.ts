import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../../lib/db.ts'
import { ALLOWED_SETTINGS, checkDatabaseSettings, REQUIRED_SETTINGS } from '../../lib/db-settings.ts'
import { migrate } from '../../scripts/migrate.ts'
import { createTestDatabase, DB, TEST_RUNTIME_PASSWORD, withClient } from '../helpers/db.ts'

const safe: Record<string, string> = {
  ...Object.fromEntries(REQUIRED_SETTINGS.map((s) => [s.name, s.expected])),
  log_min_messages: 'warning',
  log_destination: 'stderr',
  shared_preload_libraries: '',
  session_preload_libraries: '',
  local_preload_libraries: '',
}

const runtimeRole = { name: 'school_election_app', attributes: [] as string[], owner: false, memberships: [] as string[], creates: [] as string[] }

function serverWith(overrides: Record<string, string>, role: Partial<typeof runtimeRole> = {}) {
  const values = { ...safe, ...overrides }
  return {
    query: (text: string, params?: unknown[]) => Promise.resolve(text.includes('from pg_roles r where r.rolname = current_user')
      ? { rows: [{ ...runtimeRole, ...role }] }
      : { rows: (params?.[0] as string[]).map((name) => ({ name, value: values[name] ?? '' })) }),
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
      ['log_duration', 'on'],
      ['debug_print_parse', 'on'],
      ['debug_print_plan', 'on'],
      ['log_statement_stats', 'on'],
      ['log_parser_stats', 'on'],
      ['log_planner_stats', 'on'],
      ['log_executor_stats', 'on'],
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

test('auto_explain in any preload list is refused', async () => {
  for (const name of ['shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries']) {
    for (const value of ['auto_explain', 'auto_explain.so', '$libdir/auto_explain.so', 'pg_stat_statements, auto_explain', '"$libdir/plugins/auto_explain"']) {
      const problems = await checkDatabaseSettings(serverWith({ [name]: value }))
      assert.deepEqual(problems, [`${name} loads auto_explain, which logs statements with their parameters`], value)
    }
  }
  assert.deepEqual(await checkDatabaseSettings(serverWith({ shared_preload_libraries: 'pg_stat_statements' })), [])
})

test('a privileged connected role is refused', async () => {
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, { name: 'postgres', attributes: ['superuser', 'createrole'] })), [
    'the server connects as postgres; it must connect as school_election_app',
    'the server connects as postgres, which has superuser, createrole; it must use the unprivileged runtime role',
  ])
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, { name: 'school_election', owner: true })), [
    'the server connects as school_election; it must connect as school_election_app',
    'the server connects as school_election, which owns the database; it must use the unprivileged runtime role',
  ])
  // A plain role with no attributes or memberships is still the wrong role.
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, { name: 'reporting' })), [
    'the server connects as reporting; it must connect as school_election_app',
  ])
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, { memberships: ['pg_monitor'] })), [
    'the server connects as school_election_app, which is a member of pg_monitor; the runtime role must hold nothing else',
  ])
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, { creates: ['objects in schema public', 'temporary tables'] })), [
    'the server connects as school_election_app, which can create objects in schema public, temporary tables; the runtime role may only use what migrations grant',
  ])
})

test('the development and CI launcher sets every required setting', async () => {
  const script = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../scripts/postgres.sh'), 'utf8')
  for (const { name, expected } of REQUIRED_SETTINGS) {
    assert.match(script, new RegExp(`-c ${name}=${expected.replace('-', '\\-')}\\n`), name)
  }
  for (const { name, allowed } of ALLOWED_SETTINGS) {
    const value = new RegExp(`-c ${name}=([a-z,]+)\\n`).exec(script)?.[1]
    assert.ok(value?.split(',').every((entry) => allowed.includes(entry)), name)
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
  const problems = await checkDatabaseSettings(db)
  assert.ok(problems.some((p) => /connects as postgres, which has superuser/.test(p)), problems.join('\n'))
  assert.ok(problems.some((p) => /which owns the database/.test(p)), problems.join('\n'))
})

test('direct schema privileges on the runtime role are caught, and the next migration removes them', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  // Schema and database privileges are per database, so no other test sees these.
  await withClient(testDb.ownerUrl, (client) => client.query(`grant create on schema public to school_election_app; grant create, temporary on database ${testDb.name} to school_election_app`))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  assert.deepEqual(await checkDatabaseSettings(db), [
    'the server connects as school_election_app, which can create objects in schema public, schemas, temporary tables; the runtime role may only use what migrations grant',
  ])
  await migrate({ databaseUrl: testDb.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD })
  assert.deepEqual(await checkDatabaseSettings(db), [])
})

test('a role inherited through pg_read_all_settings is refused by the migrator and the startup check', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  const admin = process.env.TEST_DATABASE_URL ?? ''
  // Cluster-wide: make pg_read_all_settings a member of another role, which
  // the runtime role then inherits. Undone on the server connection.
  await withClient(admin, async (c) => {
    await c.query('create role se_inherited nologin')
    await c.query('grant se_inherited to pg_read_all_settings')
  })
  t.after(() => withClient(admin, async (c) => {
    await c.query('revoke se_inherited from pg_read_all_settings')
    await c.query('drop role se_inherited')
  }))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  assert.deepEqual(await checkDatabaseSettings(db), [
    'the server connects as school_election_app, which is a member of se_inherited; the runtime role must hold nothing else',
  ])
  await assert.rejects(
    migrate({ databaseUrl: testDb.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD }),
    /school_election_app is a member of se_inherited; revoke that first/,
  )
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
