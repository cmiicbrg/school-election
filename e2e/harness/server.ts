// Everything the browser journeys need, started as one process: a fresh
// database on the PostgreSQL server TEST_DATABASE_URL names (as the API
// tests use it), the migrations, the stand-in for Entra ID with its
// sign-in page, and the real server with the built web app, listening on
// a loopback origin. Playwright starts it (playwright.config.ts) and
// stops it; stopping drops the database.
//
// Nothing here is a production knob: the stand-in is passed to the app
// as the API tests pass it, and no environment variable of the server
// could point a deployed server at another authority.

import path from 'node:path'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../../apps/api/app.ts'
import { loadConfig } from '../../apps/api/config.ts'
import { createDatabase } from '../../apps/api/lib/db.ts'
import { createTestDatabase } from '../../apps/api/test/helpers/db.ts'
import { SERVER_ENV } from '../../apps/api/test/helpers/env.ts'
import { startFakeEntra } from '../../apps/api/test/helpers/fake-entra.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(process.env.E2E_PORT ?? 3100)
const ORIGIN = `http://127.0.0.1:${PORT}`

if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL must name a PostgreSQL superuser connection, as for the API tests (scripts/postgres.sh starts a fitting server)')
  process.exit(1)
}

// createTestDatabase registers the drop with a test context; this one
// collects what to do at the end.
const cleanups: (() => unknown)[] = []
const context = { after: (fn: () => unknown) => cleanups.push(fn) } as unknown as TestContext

const testDb = await createTestDatabase(context)
const entra = await startFakeEntra()
const db = createDatabase(testDb.runtimeUrl, (err) => console.error('database client failed', err))
const config = loadConfig({
  ...SERVER_ENV,
  PUBLIC_ORIGIN: ORIGIN,
  HOST: '127.0.0.1',
  PORT: String(PORT),
  WEB_DIST_DIR: path.join(ROOT, 'apps', 'web', 'dist'),
})
const app = await buildApp(config, { db, entraAuthority: entra.authority })
await app.listen({ host: '127.0.0.1', port: PORT })
console.log(`e2e server ready at ${ORIGIN} (database ${testDb.name}, sign-in stand-in at ${entra.authority})`)

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await app.close()
  await db.close()
  await entra.close()
  for (const cleanup of cleanups.reverse()) await cleanup()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stop().catch((err: unknown) => {
      console.error('stopping failed', err)
      process.exit(1)
    })
  })
}
