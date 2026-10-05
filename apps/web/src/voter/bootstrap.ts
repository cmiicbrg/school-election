// The key leaves the URL before the app starts. A card's QR code carries
// <app>/v#<key>: the browser never sends a fragment, and take-key.ts,
// imported first in main.ts, runs this before the router is created,
// which would otherwise read the fragment into its first route. The key
// is taken out of the address bar and the history entry and kept for the
// voter page, which asks for it exactly once. Nothing else reads the
// fragment, and no path, query, history state or storage ever holds a key.
// This module is free of the DOM, so node:test checks it with fakes.

/** The voter page's path below the app's base path. */
export const VOTER_PATH = '/v'

export interface LocationLike {
  pathname: string
  hash: string
}

export interface HistoryLike {
  state: unknown
  replaceState: (state: unknown, unused: string, url: string) => void
}

let pending: string | undefined

/**
 * On the voter page, under the app's base path, takes the key out of the
 * fragment and the history entry and keeps it for `pendingKey`; anywhere
 * else, or without a fragment, does nothing. Returns what it took.
 */
export function takeKey(location: LocationLike, history: HistoryLike, basePath = ''): string | undefined {
  const voterPath = `${basePath}${VOTER_PATH}`
  if (location.pathname !== voterPath || location.hash.length < 2) return undefined
  const key = location.hash.slice(1)
  history.replaceState(history.state, '', voterPath)
  pending = key
  return key
}

/** The key the page was opened with, once; afterwards undefined. */
export function pendingKey(): string | undefined {
  const key = pending
  pending = undefined
  return key
}
