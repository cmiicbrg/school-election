import { existsSync } from 'node:fs'
import type { Writable } from 'node:stream'
import Fastify, { LogController, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import type { Config } from './config.ts'
import { ErrorResponse, HealthResponse } from './lib/schemas/common.ts'
import { pathOf } from './lib/url.ts'
import { applyHardening } from './plugins/hardening.ts'

export interface AppOptions {
  /** Where log lines go; tests capture them. Defaults to stdout. */
  logStream?: Writable
}

export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
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
        // Only these fields of an error. Database errors carry `detail`,
        // `where` and parameter values, which can include the very values the
        // data model keeps apart.
        err: (err: FastifyError) => ({
          type: err.name,
          message: err.message,
          code: typeof err.code === 'string' ? err.code : undefined,
          stack: err.stack ?? '',
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

  const webDist = existsSync(config.webDistDir) ? config.webDistDir : undefined
  applyHardening(app, config, { webDist })

  app.get('/api/health', { schema: { response: { '200': HealthResponse, '4xx': ErrorResponse } } }, () => ({ status: 'ok' as const }))

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
