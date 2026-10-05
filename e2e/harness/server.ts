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
// collects everything to undo, in the order it was done, so that a start
// that fails halfway (a busy port, say) undoes what it did and leaves no
// database behind, and a signal undoes all of it.
const cleanups: (() => unknown)[] = []
const context = { after: (fn: () => unknown) => cleanups.push(fn) } as unknown as TestContext

let stopping = false
async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true
    // One after the other, last first: the app closes before the pool, the
    // pool before the database is dropped; a failure is logged and the rest
    // still runs.
    await cleanups.toReversed().reduce<Promise<unknown>>(
      (previous, cleanup) => previous.then(cleanup).catch((err: unknown) => {
        console.error('cleanup failed', err)
        code = 1
      }),
      Promise.resolve(),
    )
  }
  process.exit(code)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop(0)
  })
}

try {
  const testDb = await createTestDatabase(context)
  const entra = await startFakeEntra({ redirectUri: `${ORIGIN}/api/auth/callback` })
  cleanups.push(() => entra.close())
  const db = createDatabase(testDb.runtimeUrl, (err) => console.error('database client failed', err))
  cleanups.push(() => db.close())
  const config = loadConfig({
    ...SERVER_ENV,
    PUBLIC_URL: ORIGIN,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    WEB_DIST_DIR: path.join(ROOT, 'apps', 'web', 'dist'),
  })
  const app = await buildApp(config, { db, entraAuthority: entra.authority })
  cleanups.push(() => app.close())
  await app.listen({ host: '127.0.0.1', port: PORT })
  console.log(`e2e server ready at ${ORIGIN} (database ${testDb.name}, sign-in stand-in at ${entra.authority})`)
} catch (err) {
  console.error('e2e server failed to start', err)
  await stop(1)
}
