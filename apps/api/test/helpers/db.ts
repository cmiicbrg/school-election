// Real PostgreSQL for tests: one throwaway database per caller, created on
// the server named by TEST_DATABASE_URL (a superuser connection) and
// dropped afterwards. In CI the database tests must run: without
// TEST_DATABASE_URL they fail instead of being skipped quietly.

import type { TestContext } from 'node:test'
import pg from 'pg'
import { migrate, RUNTIME_ROLE } from '../../scripts/migrate.ts'

/** Contains the characters a connection URL must encode. */
export const TEST_RUNTIME_PASSWORD = 'runtime p@ss:w/rd%'

export interface TestDatabase {
  name: string
  ownerUrl: string
  runtimeUrl: string
  drop: () => Promise<void>
}

/**
 * Options for a test that needs PostgreSQL: test(name, DB, fn). Without
 * TEST_DATABASE_URL such tests are skipped locally; in CI loading the file
 * throws, so the run fails instead of passing without them.
 */
export const DB = { skip: databaseSkipReason() }

function databaseSkipReason(): string | false {
  if (process.env.TEST_DATABASE_URL) return false
  if (process.env.CI === 'true') throw new Error('TEST_DATABASE_URL must be set in CI; database tests must not be skipped')
  return 'TEST_DATABASE_URL is not set'
}

let counter = 0

/** An empty database; `migrated` also applies every migration. */
export async function createTestDatabase(t: TestContext, { migrated = true } = {}): Promise<TestDatabase> {
  const admin = new URL(process.env.TEST_DATABASE_URL ?? '')
  const name = `se_test_${process.pid}_${counter++}`
  await withClient(admin.toString(), (client) => client.query(`create database ${name}`))

  const owner = new URL(admin)
  owner.pathname = `/${name}`
  const runtime = new URL(owner)
  runtime.username = RUNTIME_ROLE
  runtime.password = encodeURIComponent(TEST_RUNTIME_PASSWORD)

  const db: TestDatabase = {
    name,
    ownerUrl: owner.toString(),
    runtimeUrl: runtime.toString(),
    drop: () => withClient(admin.toString(), (client) => client.query(`drop database if exists ${name} with (force)`)).then(() => {}),
  }
  t.after(db.drop)
  if (migrated) await migrate({ databaseUrl: db.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD })
  return db
}

export async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}
