import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.ts'
import { ConfigError, loadConfig, type Config } from './config.ts'
import { createDatabase, describeDatabase } from './lib/db.ts'
import { checkDatabaseSettings } from './lib/db-settings.ts'
import { sqlState } from './lib/pg-errors.ts'

// An operator problem: name it and stop, without a stack trace to read past.
function refuse(reason: string): never {
  console.error(`Refusing to start: ${reason}`)
  process.exit(1)
}

let config: Config
try {
  config = loadConfig(process.env)
} catch (err) {
  if (!(err instanceof ConfigError)) throw err
  refuse(err.message)
}

// The pool needs its error handler before the app (and its logger) exists.
const started: { app?: FastifyInstance } = {}
const db = createDatabase(config.databaseUrl, (err) => started.app?.log.error({ err }, 'database client failed'))

// Fail fast: an unreachable database or an unsafe server setting stops the
// process, so a restart loop is visible instead of a server answering 503s
// or running with logging that could record votes.
let problems: string[]
try {
  problems = await checkDatabaseSettings(db)
} catch (err) {
  refuse(`cannot query ${describeDatabase(config.databaseUrl)} (${(err as Error).name} ${sqlState(err) ?? ''})`.trim())
}
if (problems.length > 0) {
  refuse(`unsafe PostgreSQL settings:\n${problems.map((p) => '  - ' + p).join('\n')}`)
}

const server = await buildApp(config, { db })
started.app = server
server.addHook('onClose', () => db.close())
server.log.info({ database: describeDatabase(config.databaseUrl) }, 'database settings checked')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.log.info({ signal }, 'shutting down')
    server.close().then(
      () => process.exit(0),
      (err: unknown) => {
        server.log.error({ err }, 'shutdown failed')
        process.exit(1)
      },
    )
  })
}

await server.listen({ host: config.host, port: config.port })
