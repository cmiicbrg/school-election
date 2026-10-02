import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrate, MigrationError, MIGRATIONS_DIR } from '../../scripts/migrate.ts'
import { sqlState } from '../../lib/pg-errors.ts'
import { createTestDatabase, DB, TEST_RUNTIME_PASSWORD, withClient } from '../helpers/db.ts'

/** A copy of the real migrations plus extra files, to change freely. */
async function migrationsWith(extra: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'school-election-migrations-'))
  await cp(MIGRATIONS_DIR, dir, { recursive: true })
  for (const [name, sql] of Object.entries(extra)) await writeFile(path.join(dir, name), sql)
  return dir
}

const run = (databaseUrl: string, migrationsDir?: string) =>
  migrate({ databaseUrl, runtimePassword: TEST_RUNTIME_PASSWORD, ...(migrationsDir ? { migrationsDir } : {}) })

test('migrations apply in filename order, and a second run does nothing', DB, async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const dir = await migrationsWith({ '0002_second.sql': 'create table second (id int);', '0003_third.sql': 'alter table second add column note text;' })
  assert.deepEqual(await run(db.ownerUrl, dir), ['0001_baseline.sql', '0002_second.sql', '0003_third.sql'])
  assert.deepEqual(await run(db.ownerUrl, dir), [])
  const recorded = await withClient(db.ownerUrl, (c) => c.query<{ filename: string }>('select filename from schema_migrations order by filename'))
  assert.deepEqual(recorded.rows.map((r) => r.filename), ['0001_baseline.sql', '0002_second.sql', '0003_third.sql'])
})

test('an applied migration that was edited or removed stops the run', DB, async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const dir = await migrationsWith({ '0002_second.sql': 'create table second (id int);' })
  await run(db.ownerUrl, dir)
  await writeFile(path.join(dir, '0002_second.sql'), 'create table second (id bigint);')
  await assert.rejects(run(db.ownerUrl, dir), (err: Error) => err instanceof MigrationError && /0002_second.sql was edited/.test(err.message))
  await assert.rejects(run(db.ownerUrl, MIGRATIONS_DIR), (err: Error) => err instanceof MigrationError && /0002_second.sql is missing/.test(err.message))
})

test('a new migration that sorts before an applied one is refused', DB, async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const dir = await migrationsWith({ '0003_third.sql': 'create table third (id int);' })
  await run(db.ownerUrl, dir)
  await writeFile(path.join(dir, '0002_second.sql'), 'create table second (id int);')
  await assert.rejects(run(db.ownerUrl, dir), /0002_second.sql sorts before the applied 0003_third.sql/)
})

test('a misnamed file is refused before anything runs', DB, async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const dir = await migrationsWith({ '2_oops.sql': 'select 1;' })
  await assert.rejects(run(db.ownerUrl, dir), /must be named NNNN_name.sql: 2_oops.sql/)
})

test('a failing migration is rolled back and reported by file and SQLSTATE only', DB, async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const dir = await migrationsWith({ '0002_broken.sql': 'create table half (id int); insert into half values (\'SECRETVALUE\');' })
  await assert.rejects(run(db.ownerUrl, dir), (err: Error) => {
    assert.ok(err instanceof MigrationError)
    assert.match(err.message, /0002_broken.sql failed with SQLSTATE 22P02/)
    assert.ok(!err.message.includes('SECRETVALUE'))
    return true
  })
  const exists = await withClient(db.ownerUrl, (c) => c.query<{ t: string | null }>('select to_regclass(\'half\') as t'))
  assert.equal(exists.rows[0]?.t, null)
})

test('the runtime role cannot run migrations', DB, async (t) => {
  const db = await createTestDatabase(t)
  await assert.rejects(run(db.runtimeUrl), /must not run as the runtime role/)
})

test('a database owner that is not a superuser is refused before anything runs', DB, async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const admin = process.env.TEST_DATABASE_URL ?? ''
  await withClient(admin, async (c) => {
    await c.query('create role se_plain_owner login password \'plain\'')
    await c.query(`alter database ${db.name} owner to se_plain_owner`)
  })
  // Runs after the database is dropped, which needs the role gone last.
  t.after(() => withClient(admin, (c) => c.query('drop role if exists se_plain_owner')))
  const url = new URL(db.ownerUrl)
  url.username = 'se_plain_owner'
  url.password = 'plain'
  await assert.rejects(run(url.toString()), /must run as a PostgreSQL superuser/)
})

test('concurrent runs are serialised', DB, async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const dir = await migrationsWith({ '0002_slow.sql': 'select pg_sleep(0.5); create table slow (id int);' })
  const results = await Promise.all([run(db.ownerUrl, dir), run(db.ownerUrl, dir)])
  assert.deepEqual(results.map((r) => r.length).sort(), [0, 2])
})

test('a runtime role given more rights by hand is brought back down', DB, async (t) => {
  const db = await createTestDatabase(t)
  await withClient(db.ownerUrl, (c) => c.query('alter role school_election_app createdb createrole replication bypassrls'))
  await run(db.ownerUrl)
  const { rows } = await withClient(db.ownerUrl, (c) => c.query<Record<string, boolean>>(
    'select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin from pg_roles where rolname = $1', ['school_election_app'],
  ))
  assert.deepEqual(rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true })
})

test('a runtime role with an extra membership is refused, not silently changed', DB, async (t) => {
  const db = await createTestDatabase(t)
  await withClient(db.ownerUrl, (c) => c.query('grant pg_monitor to school_election_app'))
  // Roles are cluster-wide: undo it on the server connection, which outlives
  // this test's database, so the other tests find the role as they expect.
  t.after(() => withClient(process.env.TEST_DATABASE_URL ?? '', (c) => c.query('revoke pg_monitor from school_election_app')))
  await assert.rejects(run(db.ownerUrl), /school_election_app is a member of pg_monitor; revoke that first/)
})

test('the runtime role can connect but cannot create objects or read the migration records', DB, async (t) => {
  const db = await createTestDatabase(t)
  await withClient(db.runtimeUrl, async (client) => {
    for (const statement of ['create table intruder (id int)', 'select * from schema_migrations', 'create temporary table scratch (id int)']) {
      await assert.rejects(client.query(statement), (err) => sqlState(err) === '42501', statement)
    }
  })
})
