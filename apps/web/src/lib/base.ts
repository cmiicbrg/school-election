// Where the app is reached, as the page says. The server names the base
// path in a meta tag when it sends index.html (apps/api/lib/web-index.ts):
// "/" at the root of a host, "/wahl/" under a path of a host the app
// shares. The router, the API clients, the navigations outside the router
// and the cards derive their paths from it, so the same build runs
// anywhere. The dev server serves index.html as it is, whose tag says "/".
// Outside a browser (the tests of the pure modules) there is no document,
// and the base is the root.

/** The base path without its trailing slash: '' at the root, '/wahl' under a path. */
export function basePathOf(content: string | null | undefined): string {
  return (content ?? '/').replace(/\/$/, '')
}

/** `path`, an absolute path of the app such as /api/auth/me, under the base path. */
export function joinBase(basePath: string, path: string): string {
  return `${basePath}${path}`
}

/** `path` with the base path taken off, for the router; a path outside the base is returned as it is. */
export function stripBase(basePath: string, path: string): string {
  if (basePath === '') return path
  if (path === basePath) return '/'
  return path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path
}

// Typed as the browser's globals, which the tests of the pure modules do
// not have: they see the root.
const browser = globalThis as {
  document?: { querySelector: (selector: string) => { getAttribute: (name: string) => string | null } | null }
  location?: { origin: string }
}

export const BASE_PATH = basePathOf(browser.document?.querySelector('meta[name="base-path"]')?.getAttribute('content'))

/** The app's address as browsers use it, without a trailing slash: the origin and the base path. */
export const BASE_URL = browser.location === undefined ? '' : `${browser.location.origin}${BASE_PATH}`

export const withBase = (path: string): string => joinBase(BASE_PATH, path)
export const withoutBase = (path: string): string => stripBase(BASE_PATH, path)
