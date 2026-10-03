const BASE = 'https://return-to.invalid'

/**
 * Where to send the browser after sign-in: a path of this site, or the
 * fallback. Refused: anything not starting with a single "/" (absolute and
 * protocol-relative URLs, "/\host", which browsers read as "//host"),
 * control characters and spaces (browsers drop tabs and newlines, so
 * "/<tab>/host" would become "//host"), fragments (a voter key travels in
 * one and must never reach a server URL), and API paths.
 */
export function safeReturnTo(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string' || !/^\/(?![/\\])[\x21-\x7e]*$/.test(raw) || raw.includes('#')) return fallback
  const url = new URL(raw, BASE)
  if (url.origin !== BASE || url.pathname === '/api' || url.pathname.startsWith('/api/')) return fallback
  return raw
}
