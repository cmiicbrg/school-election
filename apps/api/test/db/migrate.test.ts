import assert from 'node:assert/strict'
import { cp, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrate, MigrationError, MIGRATIONS_DIR } from '../../scripts/migrate.ts'
import { sqlState } from '../../lib/pg-errors.ts'
import { createTestDatabase, dbTest, TEST_RUNTIME_PASSWORD, withClient } from '../helpers/db.ts'

/** A copy of the real migrations plus extra files, to change freely. */
async function migrationsWith(extra: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'school-election-migrations-'))
  await cp(MIGRATIONS_DIR, dir, { recursive: true })
  for (const [name, sql] of Object.entries(extra)) await writeFile(path.join(dir, name), sql)
  return dir
}

const run = (databaseUrl: string, migrationsDir?: string) =>
  migrate({ databaseUrl, runtimePassword: TEST_RUNTIME_PASSWORD, ...(migrationsDir ? { migrationsDir } : {}) })

dbTest('migrations apply in filename order, and a second run does nothing', async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const dir = await migrationsWith({ '0002_second.sql': 'create table second (id int);', '0003_third.sql': 'alter table second add column note text;' })
  assert.deepEqual(await run(db.ownerUrl, dir), ['0001_baseline.sql', '0002_second.sql', '0003_third.sql'])
  assert.deepEqual(await run(db.ownerUrl, dir), [])
  const recorded = await withClient(db.ownerUrl, (c) => c.query<{ filename: string }>('select filename from schema_migrations order by filename'))
  assert.deepEqual(recorded.rows.map((r) => r.filename), ['0001_baseline.sql', '0002_second.sql', '0003_third.sql'])
})

dbTest('an applied migration that was edited or removed stops the run', async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const dir = await migrationsWith({ '0002_second.sql': 'create table second (id int);' })
  await run(db.ownerUrl, dir)
  await writeFile(path.join(dir, '0002_second.sql'), 'create table second (id bigint);')
  await assert.rejects(run(db.ownerUrl, dir), (err: Error) => err instanceof MigrationError && /0002_second.sql was edited/.test(err.message))
  await assert.rejects(run(db.ownerUrl, MIGRATIONS_DIR), (err: Error) => err instanceof MigrationError && /0002_second.sql is missing/.test(err.message))
})

dbTest('a new migration that sorts before an applied one is refused', async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const dir = await migrationsWith({ '0003_third.sql': 'create table third (id int);' })
  await run(db.ownerUrl, dir)
  await writeFile(path.join(dir, '0002_second.sql'), 'create table second (id int);')
  await assert.rejects(run(db.ownerUrl, dir), /0002_second.sql sorts before the applied 0003_third.sql/)
})

dbTest('a misnamed file is refused before anything runs', async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const dir = await migrationsWith({ '2_oops.sql': 'select 1;' })
  await assert.rejects(run(db.ownerUrl, dir), /must be named NNNN_name.sql: 2_oops.sql/)
})

dbTest('a failing migration is rolled back and reported by file and SQLSTATE only', async (t) => {
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

dbTest('the runtime role cannot run migrations', async (t) => {
  const db = await createTestDatabase(t)
  await assert.rejects(run(db.runtimeUrl), /must not run as the runtime role/)
})

dbTest('concurrent runs are serialised', async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const dir = await migrationsWith({ '0002_slow.sql': 'select pg_sleep(0.5); create table slow (id int);' })
  const results = await Promise.all([run(db.ownerUrl, dir), run(db.ownerUrl, dir)])
  assert.deepEqual(results.map((r) => r.length).sort(), [0, 2])
})

dbTest('the runtime role can connect but cannot create objects or read the migration records', async (t) => {
  const db = await createTestDatabase(t)
  await withClient(db.runtimeUrl, async (client) => {
    for (const statement of ['create table intruder (id int)', 'select * from schema_migrations', 'create temporary table scratch (id int)']) {
      await assert.rejects(client.query(statement), (err) => sqlState(err) === '42501', statement)
    }
  })
})
