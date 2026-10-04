import { existsSync } from 'node:fs'
import type { Writable } from 'node:stream'
import Fastify, { LogController, type FastifyError, type FastifyInstance, type FastifyRequest, type RouteOptions } from 'fastify'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import { TALLY_VERSION } from '@school-election/election-core'
import type { Config } from './config.ts'
import type { AttemptLimiter } from './lib/attempt-limiter.ts'
import type { Database } from './lib/db.ts'
import { assertElectionGuard, onlyGuardedElectionRoutes } from './lib/election-access.ts'
import { ErrorResponse, HealthResponse } from './lib/schemas/common.ts'
import { pathOf } from './lib/url.ts'
import { applyHardening } from './plugins/hardening.ts'
import { registerSessions } from './plugins/session.ts'
import { authRoutes } from './routes/auth.ts'
import { batchRoutes } from './routes/batches.ts'
import { configurationRoutes } from './routes/configuration.ts'
import { electionRoutes } from './routes/elections.ts'
import { exportRoutes } from './routes/export.ts'
import { finalizeRoutes } from './routes/finalize.ts'
import { lotRoutes } from './routes/lots.ts'
import { memberRoutes } from './routes/members.ts'
import { pictureRoutes } from './routes/pictures.ts'
import { prepareRoutes } from './routes/prepare.ts'
import { resultRoutes } from './routes/results.ts'
import { roundRoutes } from './routes/rounds.ts'
import { voterRoutes } from './routes/voter.ts'

export interface AppOptions {
  db: Database
  /** Where log lines go; tests capture them. Defaults to stdout. */
  logStream?: Writable
  /** Where Entra ID is reached. Tests point it at a local stand-in; it is not configurable. */
  entraAuthority?: string
  /** Called with every route as it is registered; tests list them. */
  onRoute?: (route: RouteOptions) => void
  /** The voter routes' limiter and how a failing answer waits; tests pass their own. */
  voter?: { limiter?: AttemptLimiter, wait?: (ms: number) => Promise<unknown> }
}

export async function buildApp(config: Config, options: AppOptions): Promise<FastifyInstance> {
  const { db } = options
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        // What a log line may say about a request: its method and path. Not
        // the query string, not the client address or port, not headers, not
        // the body: those can carry voting keys, ballots or tokens, and
        // address plus timestamp would let a log reconstruct who voted when.
        req: (req: FastifyRequest) => ({ method: req.method, path: pathOf(req.url) }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        // An error is logged by type, code (e.g. a database SQLSTATE) and
        // stack frames, at every log level. Its message is not: exception
        // text can quote a key, a ballot or a database value, and database
        // errors also carry `detail` and parameters, which are dropped too.
        err: (err: FastifyError) => ({
          type: err.name,
          message: '[not logged]',
          code: typeof err.code === 'string' ? err.code : undefined,
          stack: stackFrames(err),
        }),
      },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    // Per-request logs (method, URL, client address, timestamp) would be a
    // record of who voted in which contest and when, which ballot secrecy
    // rules out. Failures are still logged by the error handler below.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
    // Ballots and admin payloads are small; refuse anything large early.
    // The picture upload route alone has a larger limit of its own.
    bodyLimit: 64 * 1024,
    // Strict validation: unknown properties are an error rather than being
    // stripped, and "1" is not quietly turned into 1.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  })

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ['\'self\''],
        baseUri: ['\'none\''],
        objectSrc: ['\'none\''],
        frameAncestors: ['\'none\''],
        formAction: ['\'self\''],
        imgSrc: ['\'self\'', 'data:'],
      },
    },
  })

  // Production-safe errors: a 4xx says what was wrong with the request only
  // for schema validation, whose messages name fields, never values. Other
  // client errors (an unparsable body, for instance, whose parser message
  // quotes the body) get their code alone. A 5xx is logged and answered with
  // a fixed body, so no stack trace or database message reaches a client.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500
    if (status >= 500) {
      request.log.error({ err, req: request }, 'request failed')
      return reply.code(status).send({ error: 'internal_error' })
    }
    const body: { error: string, message?: string } = { error: err.code ?? 'bad_request' }
    if (err.validation) body.message = err.message
    return reply.code(status).send(body)
  })

  // Before any route exists: an election route without the election guard
  // stops the app from starting, and no other route serves an election path.
  app.addHook('onRoute', (route) => {
    assertElectionGuard(route)
    options.onRoute?.(route)
  })
  app.addHook('onRequest', onlyGuardedElectionRoutes)

  const webDist = existsSync(config.webDistDir) ? config.webDistDir : undefined
  // Hooks before routes: a plugin context inherits only the hooks that
  // exist when it is registered, and the sign-in routes are one.
  applyHardening(app, config, { webDist })
  // The voter scope comes before the admin session: a scope inherits the
  // hooks that exist when it is registered, so the admin session's hook
  // never runs for a voter request, and the voter session's never for an
  // admin request. The voter API has no identity to see.
  await app.register(voterRoutes, { db, config, ...options.voter })
  await registerSessions(app, config)
  await app.register(authRoutes, { config, db, entraAuthority: options.entraAuthority })
  await app.register(electionRoutes, { db })
  await app.register(memberRoutes, { db })
  await app.register(configurationRoutes, { db })
  await app.register(pictureRoutes, { db })
  await app.register(prepareRoutes, { db })
  await app.register(batchRoutes, { db })
  await app.register(roundRoutes, { db, config })
  await app.register(lotRoutes, { db })
  await app.register(finalizeRoutes, { db, config })
  await app.register(resultRoutes, { db })
  await app.register(exportRoutes, { db, config })

  app.get('/api/health', { schema: { response: { '200': HealthResponse, '503': HealthResponse, '4xx': ErrorResponse } } }, async (_request, reply) => {
    const { version, gitSha } = config.build
    try {
      await db.query('select 1')
      return { status: 'ok' as const, db: 'up' as const, version, gitSha, tallyVersion: TALLY_VERSION }
    } catch (err) {
      reply.log.warn({ err }, 'health: database unreachable')
      return reply.code(503).send({ status: 'degraded', db: 'down', version, gitSha, tallyVersion: TALLY_VERSION })
    }
  })

  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      // Vite fingerprints everything under assets/, so those can be cached
      // for good; index.html must be revalidated so a deploy takes effect.
      setHeaders(reply, filePath) {
        reply.header('cache-control', filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    })
  }

  return app
}

/**
 * The frames of a stack trace without the message. V8 starts the stack with
 * `Name: message`, and the message may span lines that look like frames, so
 * that exact header is cut off first. A stack that does not start with it
 * (the message was changed after the error was created) is dropped whole.
 */
function stackFrames(err: Error): string {
  const stack = err.stack ?? ''
  const header = err.message === '' ? err.name : `${err.name}: ${err.message}`
  if (!stack.startsWith(header)) return ''
  return stack.slice(header.length).split('\n').filter((line) => /^\s+at /.test(line)).join('\n')
}
