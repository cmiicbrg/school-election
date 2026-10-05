// The web app's page as the server sends it: index.html, read once at
// startup from the build and told where the app is reached. Every page
// path gets this one document (history-mode routing), so the build's
// asset references, which are relative to the page, are made absolute
// under the base path here, and a meta tag names the base path to the
// web app, which derives its router base, its API paths and the address
// on the cards from it. At the root of a host the tag says "/".

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyReply } from 'fastify'

/** The tag as the build writes it; the server sets its content. */
export const BASE_PATH_META = '<meta name="base-path" content="/">'

export function withBasePath(html: string, basePath: string): string {
  return html
    .replaceAll('"./assets/', `"${basePath}/assets/`)
    .replace(BASE_PATH_META, `<meta name="base-path" content="${basePath}/">`)
}

export async function loadWebIndex(dir: string, basePath: string): Promise<string> {
  return withBasePath(await readFile(path.join(dir, 'index.html'), 'utf8'), basePath)
}

/** The page as every page path gets it: revalidated on every load, so a deploy takes effect. */
export function sendWebIndex(reply: FastifyReply, html: string): FastifyReply {
  return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(html)
}
