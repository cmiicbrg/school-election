// The API as the page sees it: a request from within the browser, with its
// session. Playwright's own request client would send none: the session
// cookie is Secure, and the harness speaks plain http, which only the
// browser treats as trustworthy on 127.0.0.1.

import type { Page } from '@playwright/test'

export interface Answer<T> {
  status: number
  body: T
}

/** A GET of `path` from within `page`, with the browser's session. */
export async function apiGet<T>(page: Page, path: string): Promise<Answer<T>> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    return { status: response.status, body: await response.json() as unknown }
  }, path) as Promise<Answer<T>>
}
