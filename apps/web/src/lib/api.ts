// The one way the pages talk to the API: same-origin JSON, with the
// browser's cookies, every body as JSON (the API refuses other bodies),
// and the same handling of a refusal everywhere. A 401 means the session
// is gone: the browser goes to the sign-in page and comes back to this
// one. A 204 is an answer without content, undefined to the caller.

import { ApiError, problemOf, signInUrl } from './api-rules.ts'
import { withBase } from './base.ts'

let goToSignIn: () => void = () => window.location.assign(withBase(signInUrl(window.location.pathname + window.location.search)))

/** How a 401 takes the browser to sign-in: the app registers the router, so it is a navigation within the app. */
export function onUnauthenticated(handler: () => void): void {
  goToSignIn = handler
}

export async function apiGet<T>(path: string): Promise<T> {
  return call<T>('GET', path)
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return call<T>('POST', path, body)
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return call<T>('PUT', path, body)
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return call<T>('PATCH', path, body)
}

export async function apiDelete(path: string): Promise<void> {
  await call<undefined>('DELETE', path)
}

export interface Downloaded {
  blob: Blob
  headers: Headers
}

/** A POST whose answer is a file: the body as a Blob with the headers, for the page to save; refusals and a 401 as for any call. */
export async function apiDownload(path: string): Promise<Downloaded> {
  const response = await send('POST', path)
  return { blob: await response.blob(), headers: response.headers }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await send(method, path, body)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

/** The request, with a refusal thrown and a 401 sent to sign-in; the response for the caller to read. */
async function send(method: string, path: string, body?: unknown): Promise<Response> {
  // A request without a body carries no content type: the API would refuse
  // an empty JSON body, and some routes (replacing a batch, preparing) take none.
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(withBase(path), {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 401) {
    goToSignIn()
    throw new ApiError(401, 'unauthenticated')
  }
  if (!response.ok) {
    throw problemOf(response.status, await response.json().catch(() => ({})))
  }
  return response
}
