// Placeholder entry point: just enough for the image build and smoke test to
// prove the stack (Node 26 type stripping, non-root user, security headers,
// serving the built web app). Configuration, database and routes come later.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { LogController } from 'fastify'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist')

const app = Fastify({
  logger: true,
  // Per-request logs (method, URL, client address, timestamp) would be a
  // record of who voted in which contest and when, which ballot secrecy rules out.
  logController: new LogController({ disableRequestLogging: true }),
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

app.get('/api/health', async () => ({ status: 'ok' }))

if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist })
}

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) })
