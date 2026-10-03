// The one way the pages talk to the API: same-origin JSON, with the
// browser's cookies, every body as JSON (the API refuses other bodies),
// and the same handling of a refusal everywhere. A 401 means the session
// is gone: the browser goes to the sign-in page and comes back to this
// one, unless the caller asked for null instead (the session check).

import { ApiError, problemOf, signInUrl } from './api-rules.ts'

export interface CallOptions {
  /** On 401, resolve to null instead of going to sign-in. */
  optional?: boolean
}

export async function apiGet<T>(path: string): Promise<T>
export async function apiGet<T>(path: string, options: { optional: true }): Promise<T | null>
export async function apiGet<T>(path: string, options: CallOptions = {}): Promise<T | null> {
  return call<T>('GET', path, undefined, options)
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return call<T>('POST', path, body) as Promise<T>
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return call<T>('PUT', path, body) as Promise<T>
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return call<T>('PATCH', path, body) as Promise<T>
}

export async function apiDelete(path: string): Promise<void> {
  await call<undefined>('DELETE', path)
}

async function call<T>(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<T | null> {
  // A request without a body carries no content type: the API would refuse
  // an empty JSON body, and some routes (replacing a batch, preparing) take none.
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 401) {
    if (options.optional) return null
    window.location.assign(signInUrl(window.location.pathname + window.location.search))
    throw new ApiError(401, 'unauthenticated')
  }
  if (!response.ok) {
    throw problemOf(response.status, await response.json().catch(() => ({})))
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
