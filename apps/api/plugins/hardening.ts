// Request protections every route inherits, registered before any route
// that changes state exists.

import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.ts'
import { pathOf } from '../lib/url.ts'
import { sendWebIndex } from '../lib/web-index.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The route serves content under a URL that changes whenever the
     * content does (a candidate picture by its hash), and sets its own
     * Cache-Control for a 200 or 304, which the no-store rule below keeps.
     */
    contentAddressed?: boolean
  }
}

/** `webIndex` is the web app's page, told the base path (lib/web-index.ts); without a build there is none. */
export function applyHardening(app: FastifyInstance, config: Config, { webIndex }: { webIndex?: string }): void {
  const { basePath } = config
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
  // proxy cache. The one exception is a content-addressed route's 200 or
  // 304: its URL names the content, so what a cache keeps cannot go stale.
  // Its refusals (401, 404, ...) are no-store like every other answer.
  app.addHook('onSend', (request, reply, payload, done) => {
    const cacheable = request.routeOptions.config.contentAddressed === true && (reply.statusCode === 200 || reply.statusCode === 304)
    if (isApiPath(pathOf(request.url), basePath) && !cacheable) reply.header('cache-control', 'no-store')
    done(null, payload)
  })

  // Unknown API paths get JSON. Any other GET under the base path that is
  // not a file is a route of the web app (history-mode routing), so it
  // gets the page. Nothing under assets/ is a page: a missing build file
  // must stay a 404, not turn into a successful HTML response. A path
  // outside the base path is nobody's.
  app.setNotFoundHandler((request, reply) => {
    const urlPath = pathOf(request.url)
    const isPage = (request.method === 'GET' || request.method === 'HEAD')
      && isUnder(urlPath, basePath)
      && !isApiPath(urlPath, basePath)
      && !isUnder(urlPath, `${basePath}/assets`)
      && path.extname(urlPath) === ''
    if (isPage && webIndex !== undefined) return sendWebIndex(reply, webIndex)
    return reply.code(404).send({ error: 'not_found' })
  })
}

/** Whether a path is `prefix` itself or below it; everything is under the root's empty prefix. */
function isUnder(urlPath: string, prefix: string): boolean {
  return prefix === '' || urlPath === prefix || urlPath.startsWith(`${prefix}/`)
}

function isApiPath(urlPath: string, basePath: string): boolean {
  return isUnder(urlPath, `${basePath}/api`)
}
