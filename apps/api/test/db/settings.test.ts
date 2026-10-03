import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../lib/db.ts'
import { checkDatabaseSettings, REQUIRED_SETTINGS } from '../../lib/db-settings.ts'
import { expectedPrivileges, type Privilege } from '../../lib/runtime-privileges.ts'
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

const runtimeRole = { name: 'school_election_app', attributes: [] as string[], owner: false, memberships: [] as string[], creates: [] as string[], owns: [] as string[] }

const PRELOAD = ['shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries']

interface Server {
  /** What the role can do; by default exactly the list. */
  privileges?: Privilege[]
  /** The preload settings preload_settings() returns. */
  preloadReturned?: string[]
  /** Who owns preload_settings(). */
  definer?: { owner: string, superuser: boolean }
}

function serverWith(overrides: Record<string, string>, role: Partial<typeof runtimeRole> = {}, server: Server = {}) {
  const { privileges = expectedPrivileges(), preloadReturned = PRELOAD, definer = { owner: 'postgres', superuser: true } } = server
  const values = { ...safe, ...overrides }
  const answer = (text: string, params?: unknown[]) => {
    if (text.includes('from pg_roles r where r.rolname = current_user')) return { rows: [{ ...runtimeRole, ...role }] }
    if (text.includes('has_table_privilege')) return { rows: privileges }
    if (text.includes('to_regprocedure')) return { rows: [definer] }
    if (text.includes('preload_settings()')) {
      // As in the database: no other role may call it.
      if ((role.name ?? runtimeRole.name) !== runtimeRole.name) throw Object.assign(new Error('permission denied'), { code: '42501' })
      return { rows: preloadReturned.map((name) => ({ name, setting: values[name] ?? '' })) }
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
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, { owns: Array.from({ length: 12 }, (_, i) => `t${i}`) })), [
    'the server connects as school_election_app, which owns t0, t1, t2, t3, t4, t5, t6, t7, t8, t9 and 2 more; objects belong to the role that runs the migrations',
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
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, {}, { privileges: [...expectedPrivileges(), ...extra] })), [
    'the runtime role has EXECUTE on function election_member_bind_once(), UPDATE on column election.title, UPDATE on table audit_event, USAGE on sequence audit_event_seq_seq, beyond what lib/runtime-privileges.ts grants; run the migrations, which reset its privileges',
  ])
  // A preload setting the function does not return is never read as empty.
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, {}, { preloadReturned: ['local_preload_libraries'] })), [
    'preload_settings() did not return shared_preload_libraries, session_preload_libraries; it must return every preload setting',
  ])
  // Nor is a function trusted that a role short of superuser could redefine,
  // however complete its answer.
  assert.deepEqual(await checkDatabaseSettings(serverWith({ shared_preload_libraries: 'auto_explain' }, {}, { definer: { owner: 'settings_reader', superuser: false } })), [
    'preload_settings() belongs to settings_reader, not a superuser; it must belong to the superuser that runs the migrations',
  ])
  // The option to grant a privilege on is a privilege of its own.
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, {}, { privileges: [...expectedPrivileges(), { kind: 'table', object: 'election', privilege: 'SELECT WITH GRANT OPTION' }] })), [
    'the runtime role has SELECT WITH GRANT OPTION on table election, beyond what lib/runtime-privileges.ts grants; run the migrations, which reset its privileges',
  ])
  // Fewer privileges than listed is no privacy problem; the app fails where it needs one.
  assert.deepEqual(await checkDatabaseSettings(serverWith({}, {}, { privileges: [] })), [])
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

/**
 * On a migrated database, runs `sql` as the superuser (privileges are per
 * database, so no other test sees them), expects the startup check to name
 * exactly `problems`, then nothing after the next migration run.
 */
async function repairedByNextRun(t: TestContext, sql: (database: string) => string, problems: string[]) {
  const testDb = await createTestDatabase(t)
  await withClient(testDb.ownerUrl, (c) => c.query(sql(testDb.name)))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  assert.deepEqual(await checkDatabaseSettings(db), problems)
  await migrate({ databaseUrl: testDb.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD })
  assert.deepEqual(await checkDatabaseSettings(db), [])
  return { testDb, db }
}

test('direct schema privileges on the runtime role are caught, and the next migration removes them', DB, async (t) => {
  await repairedByNextRun(t, (database) => `grant create on schema public to school_election_app; grant create, temporary on database ${database} to school_election_app`, [
    'the server connects as school_election_app, which can create objects in schema public, schemas, temporary tables; the runtime role may only use what migrations grant',
  ])
})

test('object privileges granted by hand are caught at startup, and the next migration takes them away', DB, async (t) => {
  const { testDb, db } = await repairedByNextRun(t, () => `
    grant update on audit_event to school_election_app;
    grant update (title) on election to school_election_app;
    grant references (title) on election to public;
    grant delete on app_user to public;
    grant usage on sequence audit_event_seq_seq to school_election_app;
    create function leak() returns int language sql as 'select 1';
    grant execute on function leak() to school_election_app;
    grant execute on function election_member_bind_once() to public`, [
    'the runtime role has DELETE on table app_user, EXECUTE on function election_member_bind_once(), EXECUTE on function leak(), REFERENCES on column election.title, UPDATE on column election.title, UPDATE on table audit_event, USAGE on sequence audit_event_seq_seq, beyond what lib/runtime-privileges.ts grants; run the migrations, which reset its privileges',
  ])
  // Revoking a table privilege revokes it on every column, to the role and to PUBLIC alike.
  const { rows } = await withClient(testDb.ownerUrl, (c) => c.query<{ n: number }>('select count(*)::int as n from pg_attribute where attrelid = \'election\'::regclass and attacl is not null'))
  assert.equal(rows[0]?.n, 0)
  // A function created after the run is not executable by PUBLIC either.
  await withClient(testDb.ownerUrl, (c) => c.query('create function later() returns int language sql as \'select 2\''))
  assert.deepEqual(await checkDatabaseSettings(db), [])
})

test('grant options on any privilege are caught at startup, and the next migration takes them away', DB, async (t) => {
  await repairedByNextRun(t, (database) => `
    grant connect on database ${database} to school_election_app with grant option;
    grant usage on schema public to school_election_app with grant option;
    grant select on election to school_election_app with grant option;
    grant update (user_id) on election_member to school_election_app with grant option;
    grant execute on function preload_settings() to school_election_app with grant option`, [
    'the runtime role has CONNECT WITH GRANT OPTION on database, EXECUTE WITH GRANT OPTION on function preload_settings(), SELECT WITH GRANT OPTION on table election, UPDATE WITH GRANT OPTION on column election_member.user_id, USAGE WITH GRANT OPTION on schema public, beyond what lib/runtime-privileges.ts grants; run the migrations, which reset its privileges',
  ])
})

test('default privileges for PUBLIC or the runtime role, global or per schema, are reset by the next run', DB, async (t) => {
  // Defaults grant nothing until an object is created, so the check is clean before the run, too.
  const { testDb, db } = await repairedByNextRun(t, () => `
    alter default privileges in schema public grant execute on routines to public;
    alter default privileges grant select on tables to school_election_app;
    alter default privileges in schema public grant usage on sequences to school_election_app`, [])
  await withClient(testDb.ownerUrl, async (c) => {
    const { rows } = await c.query<{ n: number }>(
      `select count(*)::int as n from pg_default_acl d, aclexplode(d.defaclacl) a
        where a.grantee in (0, (select oid from pg_roles where rolname = 'school_election_app'))`,
    )
    assert.equal(rows[0]?.n, 0)
    await c.query('create function later() returns int language sql as \'select 1\'; create table later_table (id int); create sequence later_seq')
  })
  assert.deepEqual(await checkDatabaseSettings(db), [])
})

test('a runtime role that owns an object is refused at startup and by the migrator', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  // Per database: dropped with it.
  // Whatever kind of object: the function, a collation, a large object.
  await withClient(testDb.ownerUrl, (c) => c.query(`
    alter function preload_settings() owner to school_election_app;
    create collation se_owned (locale = 'C');
    alter collation se_owned owner to school_election_app;
    select lo_create(424242);
    alter large object 424242 owner to school_election_app`))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  const problems = await checkDatabaseSettings(db)
  assert.ok(problems.includes('the server connects as school_election_app, which owns collation se_owned, function preload_settings(), large object 424242; objects belong to the role that runs the migrations'), problems.join('\n'))
  assert.ok(problems.includes('preload_settings() belongs to school_election_app, not a superuser; it must belong to the superuser that runs the migrations'), problems.join('\n'))
  await assert.rejects(
    migrate({ databaseUrl: testDb.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD }),
    /school_election_app owns collation se_owned, function preload_settings\(\), large object 424242; reassign that to the migration role first/,
  )
})

test('pg_read_all_settings, granted by earlier versions, is refused at startup and taken back by the next run', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  const admin = process.env.TEST_DATABASE_URL ?? ''
  // Cluster-wide; the run below takes it back, and so does the clean-up if it fails first.
  await withClient(admin, (c) => c.query('grant pg_read_all_settings to school_election_app'))
  t.after(() => withClient(admin, (c) => c.query('revoke pg_read_all_settings from school_election_app')).catch(() => {}))
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  const refused = ['the server connects as school_election_app, which is a member of pg_read_all_settings; the runtime role must hold nothing else']
  assert.deepEqual(await checkDatabaseSettings(db), refused)
  // A run whose migration fails keeps it: the server still deployed may need it to restart.
  const failing = await mkdtemp(path.join(tmpdir(), 'school-election-migrations-'))
  await cp(MIGRATIONS_DIR, failing, { recursive: true })
  await writeFile(path.join(failing, '9001_broken.sql'), 'select 1/0;')
  await assert.rejects(migrate({ databaseUrl: testDb.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD, migrationsDir: failing }), /9001_broken.sql failed/)
  assert.deepEqual(await checkDatabaseSettings(db), refused)
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
