import { buildApp } from './app.ts'
import { ConfigError, loadConfig, type Config } from './config.ts'

let config: Config
try {
  config = loadConfig(process.env)
} catch (err) {
  if (!(err instanceof ConfigError)) throw err
  // A configuration mistake is an operator problem: name it and stop,
  // without a stack trace to read past.
  console.error(`Refusing to start: ${err.message}`)
  process.exit(1)
}

const app = await buildApp(config)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'shutdown failed')
        process.exit(1)
      },
    )
  })
}

await app.listen({ host: config.host, port: config.port })
