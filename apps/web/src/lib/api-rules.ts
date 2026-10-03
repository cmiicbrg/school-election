// What the pages know about the API's answers, free of the DOM so that
// node:test can check it: how a refusal is represented, and where a
// signed-out person is sent.

/** A refused request: the API's error code and, for a validation error, its message. */
export class ApiError extends Error {
  override name = 'ApiError'
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.status = status
    this.code = code
  }
}

/** The API's error body, as every refusal carries it. */
export function problemOf(status: number, payload: unknown): ApiError {
  const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const code = typeof body.error === 'string' && body.error !== '' ? body.error : 'request_failed'
  const message = typeof body.message === 'string' ? body.message : undefined
  return new ApiError(status, code, message)
}

/** Where sign-in starts, coming back to `returnTo`, a path of this app. */
export function signInUrl(returnTo: string): string {
  const path = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/'
  return `/api/auth/login?returnTo=${encodeURIComponent(path)}`
}
