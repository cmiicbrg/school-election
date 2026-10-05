// The base path the journeys run under: E2E_BASE_PATH, which is /wahl
// unless set (an empty value is the root of the host). The harness starts
// the server with it (PUBLIC_URL), playwright.config.ts puts it into the
// base URL, and the specs address the app through the helpers here, so no
// journey writes it. The root is covered by the API tests and the image's
// smoke test.

export const BASE_PATH = process.env.E2E_BASE_PATH ?? '/wahl'

/** `path`, an absolute path of the app such as /wahlen/neu or /v#KEY, for page.goto: relative to the base URL, which ends in a slash. */
export function at(path: string): string {
  return path === '/' ? '.' : path.replace(/^\//, '')
}

/** What the browser's address ends in on `path` of the app, for toHaveURL. */
export function urlOf(path: string): RegExp {
  return new RegExp(`${escaped(`${BASE_PATH}${path}`)}$`)
}

/** `path` of the app as a return path in a query string, with each slash as the router or the browser writes it, for a RegExp. */
export function encodedPath(path: string): string {
  return escaped(`${BASE_PATH}${path}`).replaceAll('\\/', '(%2F|\\/)')
}

function escaped(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}
