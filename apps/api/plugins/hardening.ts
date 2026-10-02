// Request protections every route inherits, registered before any route
// that changes state exists.

import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.ts'
import { pathOf } from '../lib/url.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function applyHardening(app: FastifyInstance, config: Config, { webDist }: { webDist?: string }): void {
  // CSRF: a state-changing request must come from our own pages. Browsers
  // send Sec-Fetch-Site on every request; only "same-origin" passes. Older
  // browsers without it still send Origin on a POST, which must then be our
  // own origin. A request with neither is refused too, so a non-browser
  // client has to say where it comes from.
  app.addHook('onRequest', (request, reply, done) => {
    const fetchSite = request.headers['sec-fetch-site']
    const sameOrigin = fetchSite === undefined
      ? request.headers.origin === config.publicOrigin
      : fetchSite === 'same-origin'
    if (!SAFE_METHODS.has(request.method) && !sameOrigin) {
      // Replying ends the request; done() must not be called as well.
      void reply.code(403).send({ error: 'cross_site_request' })
      return
    }
    done()
  })

  // Bodies are JSON only. Fastify parses text/plain by default, and a
  // text/plain or form-encoded POST is what a cross-site form can send
  // without a preflight; with no parser for them they are refused with 415.
  app.removeContentTypeParser('text/plain')

  // API responses carry election state and must not sit in a browser or
  // proxy cache.
  app.addHook('onSend', (request, reply, payload, done) => {
    if (isApiPath(pathOf(request.url))) reply.header('cache-control', 'no-store')
    done(null, payload)
  })

  // Unknown API paths get JSON. Any other GET that is not a file is a route
  // of the web app (history-mode routing), so it gets index.html. Nothing
  // under /assets/ is a page: a missing build file must stay a 404, not turn
  // into a successful HTML response.
  app.setNotFoundHandler((request, reply) => {
    const urlPath = pathOf(request.url)
    const isPage = (request.method === 'GET' || request.method === 'HEAD')
      && !isApiPath(urlPath)
      && urlPath !== '/assets' && !urlPath.startsWith('/assets/')
      && path.extname(urlPath) === ''
    if (isPage && webDist) {
      return reply.header('cache-control', 'no-cache').type('text/html').sendFile('index.html', webDist)
    }
    return reply.code(404).send({ error: 'not_found' })
  })
}

function isApiPath(urlPath: string): boolean {
  return urlPath === '/api' || urlPath.startsWith('/api/')
}
