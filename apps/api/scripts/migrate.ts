#!/usr/bin/env node
// Applies the SQL migrations in ../migrations, in filename order, one
// transaction per file. Run as a PostgreSQL superuser, because it creates
// and adjusts the runtime role, as a one-shot step before the server
// starts; a run with nothing to do is a no-op, so a redeploy can always run
// it.
//
// Deterministic: each applied file is recorded with its SHA-256, and an
// applied file that was edited or removed stops the run, so two databases
// with the same records have the same schema.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ConfigError, loadMigrationConfig } from '../config.ts'
import { RUNTIME_ROLE } from '../lib/db.ts'
import { SQLSTATE, sqlState } from '../lib/pg-errors.ts'

export { RUNTIME_ROLE }
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

// One fixed key: pg_advisory_lock serialises concurrent runs on a database.
const LOCK_KEY = 0x5c0e1ec7
const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/

export interface MigrateOptions {
  /** Owner connection string, password included. */
  databaseUrl: string
  runtimePassword: string
  migrationsDir?: string
  /** Apply files up to and including this one; tests use it to stop between migrations. */
  until?: string
  log?: (line: string) => void
}

export class MigrationError extends Error {
  override name = 'MigrationError'
}

/**
 * The one order migrations run in: by UTF-16 code unit, independent of
 * locale. Sorting and the forward-only check must use the same order.
 */
export function byName(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

export async function migrate(options: MigrateOptions): Promise<string[]> {
  const { databaseUrl, runtimePassword, migrationsDir = MIGRATIONS_DIR, until, log = () => {} } = options
  const files = await migrationFiles(migrationsDir, until)
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'school-election-migrate' })
  await client.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY])
    // Unqualified names, in the bookkeeping and in the migrations, resolve in
    // public only, whatever search_path the superuser would otherwise have.
    await client.query('select set_config(\'search_path\', \'public\', false)')
    await assertMigrationRole(client)
    await client.query(`create table if not exists schema_migrations (
      filename text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )`)
    const applied = new Map((await client.query<{ filename: string, sha256: string }>(
      'select filename, sha256 from schema_migrations',
    )).rows.map((row) => [row.filename, row.sha256]))

    // The history is validated before the runtime role is touched.
    const pending = pendingMigrations(files, applied, migrationsDir, until)
    const existed = await ensureRuntimeRole(client, runtimePassword)
    await resetRuntimePrivileges(client)
    for (const file of pending) {
      log(`applying ${file.name}`)
      await applyMigration(client, file) // NOSONAR: migrations run one after another, each in its own transaction
    }
    // The password of an existing role changes only now: a run that fails
    // above leaves the old password, and with it the running server, working.
    if (existed) await setRuntimePassword(client, runtimePassword)
    log(pending.length === 0 ? 'nothing to apply' : `applied ${pending.length} migration(s)`)
    return pending.map((file) => file.name)
  } finally {
    await client.end()
  }
}

interface MigrationFile {
  name: string
  sql: string
  sha256: string
}

async function assertMigrationRole(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ current_user: string, superuser: boolean }>(
    'select current_user, (select rolsuper from pg_roles where rolname = current_user) as superuser',
  )
  if (rows[0]?.current_user === RUNTIME_ROLE) {
    throw new MigrationError(`migrations must not run as the runtime role ${RUNTIME_ROLE}`)
  }
  // Checked up front rather than failing halfway at CREATE ROLE: owning the
  // database is not enough to create and adjust the runtime role.
  if (rows[0]?.superuser !== true) {
    throw new MigrationError('migrations must run as a PostgreSQL superuser: they create and adjust the runtime role')
  }
}

/**
 * The files still to apply, after checking that the history is intact: no
 * applied file edited or missing, and no new file that sorts before the
 * newest applied one, or two databases with the same records could have run
 * the same files in different orders.
 */
export function pendingMigrations(
  files: readonly MigrationFile[],
  applied: ReadonlyMap<string, string>,
  migrationsDir: string,
  until?: string,
): MigrationFile[] {
  const known = new Set(files.map((file) => file.name))
  const missing = [...applied.keys()].find((name) => !known.has(name) && (until === undefined || name <= until))
  if (missing) throw new MigrationError(`applied migration ${missing} is missing from ${migrationsDir}`)

  const edited = files.find((file) => applied.has(file.name) && applied.get(file.name) !== file.sha256)
  if (edited) throw new MigrationError(`applied migration ${edited.name} was edited; write a new migration instead`)

  const pending = files.filter((file) => !applied.has(file.name))
  const newest = [...applied.keys()].sort(byName).at(-1)
  const late = newest === undefined ? undefined : pending.find((file) => file.name < newest)
  if (late) {
    throw new MigrationError(`${late.name} sorts before the applied ${newest}; renumber it after the newest applied migration`)
  }
  return pending
}

async function applyMigration(client: pg.Client, file: MigrationFile): Promise<void> {
  await client.query('begin')
  try {
    await client.query(file.sql)
    await client.query('insert into schema_migrations (filename, sha256) values ($1, $2)', [file.name, file.sha256])
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    // The code and the file, not the database's message: messages can quote
    // values from the rows a migration touches.
    throw new MigrationError(`${file.name} failed with SQLSTATE ${sqlState(err) ?? 'unknown'}; nothing of it was applied`, { cause: err })
  }
}

async function migrationFiles(dir: string, until: string | undefined): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort(byName)
  const bad = names.filter((name) => !FILE_NAME.test(name))
  if (bad.length > 0) throw new MigrationError(`migration files must be named NNNN_name.sql: ${bad.join(', ')}`)
  // One file per number: fixtures and reviews refer to migrations by it.
  const duplicate = names.find((name, i) => i > 0 && name.slice(0, 4) === names[i - 1]?.slice(0, 4))
  if (duplicate) throw new MigrationError(`migration number ${duplicate.slice(0, 4)} is used more than once`)
  const selected = until === undefined ? names : names.filter((name) => name <= until)
  return Promise.all(selected.map(async (name) => {
    const sql = await readFile(path.join(dir, name), 'utf8')
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') }
  }))
}

// The runtime role logs in with its own password and holds nothing but what
// migrations grant it. Its attributes are set on every run, so a role that
// was created or changed by hand with more rights is brought back down; a
// membership in any other role is refused rather than silently revoked.
// pg_read_all_settings lets the server check its privacy settings at
// startup; it gives no access to data.
export const RUNTIME_MEMBERSHIPS = ['pg_read_all_settings']
const UNPRIVILEGED = 'login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit'

/** Creates the runtime role, or resets the attributes of the existing one; true if it existed. */
async function ensureRuntimeRole(client: pg.Client, password: string): Promise<boolean> {
  let existed = (await client.query('select 1 from pg_roles where rolname = $1', [RUNTIME_ROLE])).rowCount === 1
  if (!existed) {
    try {
      await client.query(await formatted(client, `create role %I with ${UNPRIVILEGED} password %L`, scramVerifier(password)))
    } catch (err) {
      if (sqlState(err) !== SQLSTATE.duplicateObject) throw err
      existed = true
    }
  }
  if (existed) await client.query(await formatted(client, `alter role %I with ${UNPRIVILEGED}`))
  await client.query(`grant ${RUNTIME_MEMBERSHIPS.join(', ')} to ${RUNTIME_ROLE}`)

  // Effective membership, not only direct grants: a role granted to an
  // allowed role is inherited just the same.
  const memberships = await client.query<{ rolname: string }>(
    `select granted.rolname::text as rolname from pg_roles granted, pg_roles runtime
      where runtime.rolname = $1 and granted.oid <> runtime.oid
        and pg_has_role(runtime.oid, granted.oid, 'MEMBER')
        and not (granted.rolname = any($2::text[]))`,
    [RUNTIME_ROLE, RUNTIME_MEMBERSHIPS],
  )
  if (memberships.rows.length > 0) {
    const names = memberships.rows.map((row) => row.rolname).sort(byName).join(', ')
    throw new MigrationError(`${RUNTIME_ROLE} is a member of ${names}; revoke that first, the runtime role must hold nothing else`)
  }
  return existed
}

async function setRuntimePassword(client: pg.Client, password: string): Promise<void> {
  await client.query(await formatted(client, 'alter role %I with password %L', scramVerifier(password)))
}

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for a password, computed
 * here so the password itself never travels as SQL text: statement logs and
 * pg_stat_statements would otherwise keep it in plaintext. A verifier
 * cannot be used to log in. The password is printable ASCII (checked in
 * config.ts), for which SASLprep changes nothing.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

// Utility statements take no bind parameters; format() quotes server-side.
async function formatted(client: pg.Client, template: string, password?: string): Promise<string> {
  const { rows } = await client.query<{ sql: string }>('select format($1, $2::text, $3::text) as sql', [template, RUNTIME_ROLE, password ?? null])
  return rows[0]?.sql ?? ''
}

// Database and schema privileges are per database, so they are reset here on
// every run: a reused runtime role may hold direct privileges granted by
// hand, such as CREATE on the schema. CONNECT and USAGE are all it keeps;
// table privileges come from the migrations themselves.
async function resetRuntimePrivileges(client: pg.Client): Promise<void> {
  // One transaction: a running server never sees the moment between revoke
  // and grant. PUBLIC is reset too, so a database restored from a dump (which
  // starts with the default privileges) is repaired by the next run.
  await client.query('begin')
  try {
    await client.query(`do $$ begin
      execute format('revoke all on database %I from public, ${RUNTIME_ROLE}', current_database());
      execute format('grant connect on database %I to ${RUNTIME_ROLE}', current_database());
    end $$`)
    await client.query(`revoke all on schema public from public, ${RUNTIME_ROLE}`)
    await client.query(`grant usage on schema public to ${RUNTIME_ROLE}`)
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = loadMigrationConfig(process.env)
    await migrate({ ...config, log: (line) => console.log(line) })
  } catch (err) {
    if (err instanceof ConfigError || err instanceof MigrationError) {
      console.error(`Migration refused: ${err.message}`)
    } else {
      // A database error: report its code, not its message, which can quote
      // values from the statement.
      console.error(`Migration failed: ${(err as Error).name} ${sqlState(err) ?? ''}`.trim())
    }
    process.exit(1)
  }
}
