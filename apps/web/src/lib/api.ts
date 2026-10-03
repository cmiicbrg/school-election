// The one way the pages talk to the API: same-origin JSON, with the
// browser's cookies, every body as JSON (the API refuses other bodies),
// and the same handling of a refusal everywhere. A 401 means the session
// is gone: the browser goes to sign-in and comes back to this page.

import { ApiError, problemOf, signInUrl } from './api-rules.ts'

export async function apiGet<T>(path: string): Promise<T> {
  return call<T>('GET', path)
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return call<T>('POST', path, body)
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'accept': 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 401) {
    window.location.assign(signInUrl(window.location.pathname + window.location.search))
    throw new ApiError(401, 'unauthenticated')
  }
  if (!response.ok) {
    throw problemOf(response.status, await response.json().catch(() => ({})))
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
