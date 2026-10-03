// The printable sheet's arithmetic and text, free of the DOM so that
// node:test can check it: six cards to an A4 page, what a card carries,
// and what the QR code says. The page (pages/PrintBatch.vue) lays it out.

import { formatKey, keyUrl, type Lifecycle, type RoundKind } from '@school-election/election-core'

/** Two columns by three rows on A4 portrait. */
export const CARDS_PER_PAGE = 6

export interface Card {
  /** The key as stored, normalised. */
  key: string
  /** The key as printed: five groups of four. */
  grouped: string
  /** What the QR code carries: the voter page with the key in the fragment. */
  url: string
}

export function cardsOf(keys: readonly string[], origin: string): Card[] {
  return keys.map((key) => ({ key, grouped: formatKey(key), url: keyUrl(origin, key) }))
}

/** The items in pages of `perPage`, the last one shorter. */
export function pagesOf<T>(items: readonly T[], perPage = CARDS_PER_PAGE): T[][] {
  if (!Number.isInteger(perPage) || perPage < 1) throw new RangeError(`not a page size: ${perPage}`)
  const pages: T[][] = []
  for (let start = 0; start < items.length; start += perPage) pages.push(items.slice(start, start + perPage))
  return pages
}

export function pageCount(count: number, perPage = CARDS_PER_PAGE): number {
  return Math.ceil(count / perPage)
}

/** The round a batch is for, as a card names it. */
export const ROUND_LABELS: Readonly<Record<RoundKind, string>> = { regular: 'Wahl', runoff: 'Stichwahl' }

/** The address a voter types instead of scanning: the host and the voter page, without a scheme. */
export function voterAddress(origin: string): string {
  return `${new URL(origin).host}/v`
}

/**
 * Whether a batch of the round can still be printed: until its round
 * opens. Once votes are accepted, a sheet printed then could only raise
 * the question whose it is; after the close, the codes and their use are
 * what is shown. A runoff batch prints until the runoff is activated.
 */
export function printable(lifecycle: Lifecycle, kind: RoundKind): boolean {
  if (lifecycle.election === 'final') return false
  return kind === 'regular' ? lifecycle.regular === 'planned' : lifecycle.runoff === null
}
