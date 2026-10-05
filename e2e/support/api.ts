// The API as the page sees it: a request from within the browser, with its
// session. Playwright's own request client would send none: the session
// cookie is Secure, and the harness speaks plain http, which only the
// browser treats as trustworthy on 127.0.0.1.

import type { Page } from '@playwright/test'
import { BASE_PATH } from './base.ts'
import { expectFailure } from './console.ts'

export interface Answer<T> {
  status: number
  body: T
}

/** A GET of `path` (an API path of the app, under its base path) from within `page`, with the browser's session; a refusal is the spec's to assert, not a console finding. */
export async function apiGet<T>(page: Page, path: string): Promise<Answer<T>> {
  const answer = await page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    return { status: response.status, body: await response.json() as unknown }
  }, `${BASE_PATH}${path}`) as Answer<T>
  if (answer.status >= 400) expectFailure(new URL(`${BASE_PATH}${path}`, page.url()).toString())
  return answer
}

/** A POST of `path` from within `page`, with the browser's session and `body` as JSON when given; a refusal is the spec's to assert. */
export async function apiPost<T>(page: Page, path: string, body?: unknown): Promise<Answer<T>> {
  const answer = await page.evaluate(async ([url, payload]) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: payload === undefined ? { accept: 'application/json' } : { 'accept': 'application/json', 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() as unknown }
  }, [`${BASE_PATH}${path}`, body] as const) as Answer<T>
  if (answer.status >= 400) expectFailure(new URL(`${BASE_PATH}${path}`, page.url()).toString())
  return answer
}
