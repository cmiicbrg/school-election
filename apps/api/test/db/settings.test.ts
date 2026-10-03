import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../lib/db.ts'
import { checkDatabaseSettings, REQUIRED_SETTINGS } from '../../lib/db-settings.ts'
import { expectedPrivileges, type Privilege } from '../../lib/runtime-privileges.ts'
import { sqlState } from '../../lib/pg-errors.ts'
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

function serverWith(overrides: Record<string, string>, role: Partial<typeof runtimeRole> = {}, privileges: Privilege[] = expectedPrivileges()) {
  const values = { ...safe, ...overrides }
  const answer = (text: string, params?: unknown[]) => {
    if (text.includes('from pg_roles r where r.rolname = current_user')) return { rows: [{ ...runtimeRole, ...role }] }
    if (text.includes('has_table_privilege')) return { rows: privileges }
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

test('a privilege beyond the runtime list is refused, whatever kind of object it is on', async () => {
  const extra: Privilege[] = [
    { kind: 'table', object: 'audit_event', privilege: 'UPDATE' },
    { kind: 'column', object: 'election.title', privilege: 'UPDATE' },
    { kind: 'sequence', object: 'audit_event_seq_seq', privilege: 'USAGE' },
    { kind: 'function', object: 'election_member_bind_once()', privilege: 'EXECUTE' },
  ]
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, {}, [...expectedPrivileges(), ...extra])), [
    'the runtime role has EXECUTE on function election_member_bind_once(), UPDATE on column election.title, UPDATE on table audit_event, USAGE on sequence audit_event_seq_seq, beyond what lib/runtime-privileges.ts grants; run the migrations, which reset its privileges',
  ])
  // Fewer privileges than listed is no privacy problem; the app fails where it needs one.
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, {}, [])), [])
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

test('object privileges granted by hand are caught at startup, and the next migration takes them away', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  // Per database, so no other test sees these.
  await withClient(testDb.ownerUrl, (c) => c.query(`
    grant update on audit_event to school_election_app;
    grant update (title) on election to school_election_app;
    grant delete on app_user to public;
    grant usage on sequence audit_event_seq_seq to school_election_app;
    create function leak() returns int language sql as 'select 1';
    grant execute on function leak() to school_election_app;
    grant execute on function election_member_bind_once() to public`))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  assert.deepEqual(await checkDatabaseSettings(db), [
    'the runtime role has DELETE on table app_user, EXECUTE on function election_member_bind_once(), EXECUTE on function leak(), UPDATE on column election.title, UPDATE on table audit_event, USAGE on sequence audit_event_seq_seq, beyond what lib/runtime-privileges.ts grants; run the migrations, which reset its privileges',
  ])
  await migrate({ databaseUrl: testDb.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD })
  assert.deepEqual(await checkDatabaseSettings(db), [])
  // A function created after the run is not executable by PUBLIC either.
  await withClient(testDb.ownerUrl, (c) => c.query('create function later() returns int language sql as \'select 2\''))
  assert.deepEqual(await checkDatabaseSettings(db), [])
})

test('pg_read_all_settings, granted by earlier versions, is refused at startup and taken back by the next run', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  const admin = process.env.TEST_DATABASE_URL ?? ''
  // Cluster-wide; the run below takes it back, and so does the clean-up if it fails first.
  await withClient(admin, (c) => c.query('grant pg_read_all_settings to school_election_app'))
  t.after(() => withClient(admin, (c) => c.query('revoke pg_read_all_settings from school_election_app')).catch(() => {}))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  assert.deepEqual(await checkDatabaseSettings(db), [
    'the server connects as school_election_app, which is a member of pg_read_all_settings; the runtime role must hold nothing else',
  ])
  await migrate({ databaseUrl: testDb.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD })
  assert.deepEqual(await checkDatabaseSettings(db), [])
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
