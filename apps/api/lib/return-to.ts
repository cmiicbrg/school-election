const BASE = 'https://return-to.invalid'

/**
 * Where to send the browser after sign-in: a page path of this app, under
 * its base path, or the app's start page. Refused: anything not starting
 * with a single "/" (absolute and protocol-relative URLs, "/\host", which
 * browsers read as "//host"), control characters and spaces (browsers drop
 * tabs and newlines, so "/<tab>/host" would become "//host"), fragments (a
 * voter key travels in one and must never reach a server URL), API paths,
 * and a path outside the base path, which is another app's on a shared
 * host.
 */
export function safeReturnTo(raw: unknown, basePath = ''): string {
  const fallback = `${basePath}/`
  if (typeof raw !== 'string' || !/^\/(?![/\\])[\x21-\x7e]*$/.test(raw) || raw.includes('#')) return fallback
  const url = new URL(raw, BASE)
  if (url.origin !== BASE) return fallback
  const inside = url.pathname === basePath || url.pathname.startsWith(fallback)
  const api = url.pathname === `${basePath}/api` || url.pathname.startsWith(`${basePath}/api/`)
  return inside && !api ? raw : fallback
}
