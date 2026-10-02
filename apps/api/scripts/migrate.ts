#!/usr/bin/env node
// Applies the SQL migrations in ../migrations, in filename order, one
// transaction per file. Run with the database owner's credentials as a
// one-shot step before the server starts; a run with nothing to do is a
// no-op, so a redeploy can always run it.
//
// Deterministic: each applied file is recorded with its SHA-256, and an
// applied file that was edited or removed stops the run, so two databases
// with the same records have the same schema.

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ConfigError, loadMigrationConfig } from '../config.ts'
import { SQLSTATE, sqlState } from '../lib/pg-errors.ts'

export const RUNTIME_ROLE = 'school_election_app'
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
    const { rows } = await client.query<{ current_user: string }>('select current_user')
    if (rows[0]?.current_user === RUNTIME_ROLE) {
      throw new MigrationError(`migrations must not run as the runtime role ${RUNTIME_ROLE}`)
    }
    await ensureRuntimeRole(client, runtimePassword)
    await client.query(`create table if not exists schema_migrations (
      filename text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )`)
    const applied = new Map((await client.query<{ filename: string, sha256: string }>(
      'select filename, sha256 from schema_migrations',
    )).rows.map((row) => [row.filename, row.sha256]))

    const known = new Set(files.map((file) => file.name))
    for (const name of applied.keys()) {
      if (!known.has(name) && (until === undefined || name <= until)) {
        throw new MigrationError(`applied migration ${name} is missing from ${migrationsDir}`)
      }
    }

    // Forward-only: a new file must sort after every applied one, or two
    // databases with the same records could have run them in different
    // orders.
    const newest = [...applied.keys()].sort(byName).at(-1)
    const late = files.find((file) => !applied.has(file.name) && newest !== undefined && file.name < newest)
    if (late) {
      throw new MigrationError(`${late.name} sorts before the applied ${newest}; renumber it after the newest applied migration`)
    }

    const ran: string[] = []
    for (const file of files) {
      const recorded = applied.get(file.name)
      if (recorded !== undefined) {
        if (recorded !== file.sha256) {
          throw new MigrationError(`applied migration ${file.name} was edited; write a new migration instead`)
        }
        continue
      }
      log(`applying ${file.name}`)
      await client.query('begin')
      try {
        await client.query(file.sql)
        await client.query('insert into schema_migrations (filename, sha256) values ($1, $2)', [file.name, file.sha256])
        await client.query('commit')
      } catch (err) {
        await client.query('rollback').catch(() => {})
        // The code and the file, not the database's message: messages can
        // quote values from the rows a migration touches.
        throw new MigrationError(`${file.name} failed with SQLSTATE ${sqlState(err) ?? 'unknown'}; nothing of it was applied`, { cause: err })
      }
      ran.push(file.name)
    }
    log(ran.length === 0 ? 'nothing to apply' : `applied ${ran.length} migration(s)`)
    return ran
  } finally {
    await client.end()
  }
}

async function migrationFiles(dir: string, until: string | undefined) {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort(byName)
  const bad = names.filter((name) => !FILE_NAME.test(name))
  if (bad.length > 0) throw new MigrationError(`migration files must be named NNNN_name.sql: ${bad.join(', ')}`)
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

async function ensureRuntimeRole(client: pg.Client, password: string): Promise<void> {
  const exists = (await client.query('select 1 from pg_roles where rolname = $1', [RUNTIME_ROLE])).rowCount === 1
  // Utility statements take no bind parameters; format() quotes server-side.
  const statement = `${exists ? 'alter' : 'create'} role %I with ${UNPRIVILEGED} password %L`
  const { rows } = await client.query<{ sql: string }>(`select format('${statement}', $1::text, $2::text) as sql`, [RUNTIME_ROLE, password])
  try {
    await client.query(rows[0]?.sql ?? '')
  } catch (err) {
    if (sqlState(err) !== SQLSTATE.duplicateObject) throw err
  }

  const memberships = await client.query<{ rolname: string }>(
    `select granted.rolname from pg_auth_members m
       join pg_roles granted on granted.oid = m.roleid
       join pg_roles member on member.oid = m.member
      where member.rolname = $1 and not (granted.rolname = any($2::text[]))`,
    [RUNTIME_ROLE, RUNTIME_MEMBERSHIPS],
  )
  if (memberships.rows.length > 0) {
    const names = memberships.rows.map((row) => row.rolname).sort(byName).join(', ')
    throw new MigrationError(`${RUNTIME_ROLE} is a member of ${names}; revoke that first, the runtime role must hold nothing else`)
  }
  for (const role of RUNTIME_MEMBERSHIPS) await client.query(`grant ${role} to ${RUNTIME_ROLE}`)
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
