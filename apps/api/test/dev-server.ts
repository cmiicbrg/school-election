// The API for development without a Microsoft tenant: the server as
// `npm run dev:api` starts it, from apps/api/.env, but signing in goes to
// the stand-in for Entra ID the browser journeys use (helpers/fake-entra.ts),
// whose page offers the test people and any name and address typed in.
// Everything else is the real server against the developer's database.
//
// It is a program of its own, not a setting: server.ts, which the image
// runs, has no way to take another authority, and this file lives under
// test/, which the image leaves out (.dockerignore). It starts only on this
// machine's loopback, with a loopback PUBLIC_URL, and says at start that
// sign-in is the stand-in.
//
//   npm run dev:api:fake-entra    beside npm run dev:web, then open PUBLIC_URL

import { buildApp } from '../app.ts'
import { ConfigError, isLoopbackHost, loadConfig, type Config } from '../config.ts'
import { createDatabase, describeDatabase } from '../lib/db.ts'
import { checkDatabaseSettings } from '../lib/db-settings.ts'
import { sqlState } from '../lib/pg-errors.ts'
import { CLIENT_ID, CLIENT_SECRET, secretFile, TENANT_ID } from './helpers/env.ts'
import { startFakeEntra } from './helpers/fake-entra.ts'

function refuse(reason: string): never {
  console.error(`Refusing to start: ${reason}`)
  process.exit(1)
}

// The developer's settings, with the registration the stand-in knows in
// place of the one in .env: it issues codes and tokens for that one only.
let config: Config
try {
  config = loadConfig({
    ...process.env,
    ENTRA_TENANT_ID: TENANT_ID,
    ENTRA_CLIENT_ID: CLIENT_ID,
    ENTRA_CLIENT_SECRET_FILE: secretFile('entra-client-secret', `${CLIENT_SECRET}\n`),
  })
} catch (err) {
  if (!(err instanceof ConfigError)) throw err
  refuse(err.message)
}
if (!isLoopbackHost(config.host) || !isLoopbackHost(new URL(config.publicUrl).hostname)) {
  refuse(`the test sign-in runs on this machine only: HOST (${config.host}) and PUBLIC_URL (${config.publicUrl}) must be loopback addresses`)
}

const entra = await startFakeEntra({ redirectUri: `${config.publicUrl}/api/auth/callback` })
const db = createDatabase(config.databaseUrl, (err) => console.error('database client failed', err))

let problems: string[]
try {
  problems = await checkDatabaseSettings(db)
} catch (err) {
  refuse(`cannot query ${describeDatabase(config.databaseUrl)} (${(err as Error).name} ${sqlState(err) ?? ''})`.trim())
}
if (problems.length > 0) {
  refuse(`unsafe PostgreSQL settings:\n${problems.map((p) => '  - ' + p).join('\n')}`)
}

const server = await buildApp(config, { db, entraAuthority: entra.authority })
server.addHook('onClose', async () => {
  await db.close()
  await entra.close()
})
server.log.warn({ authority: entra.authority }, 'sign-in is the test stand-in, not Microsoft Entra ID: for development only')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close().then(() => process.exit(0), () => process.exit(1))
  })
}

await server.listen({ host: config.host, port: config.port })
