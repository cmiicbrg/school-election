// Ballot validation: the single authority on what a valid ballot is.
//
// A ballot is an ordered array of candidate ids. Index 0 fills the highest
// slot, index 1 the next, and so on; the slot, and with it the points, follows
// from the position alone. That form cannot express a duplicate slot or a
// skipped one, so the only ways to be wrong are the ones checked below.
//
// Completeness is part of validity: every active slot must be filled with a
// distinct candidate. A voter cannot award the top points and withhold the
// rest, because the lower positions decide deputies and runoff tiebreaks.

import { activeSlots, isRulesetId, RULESETS, type RulesetId, type Slot } from './rulesets.ts'

export interface Contest {
  readonly rulesetId: RulesetId
  /** Every candidate standing in this contest, in display order. */
  readonly candidateIds: readonly string[]
}

declare const validBallot: unique symbol

/** A ballot that passed validateBallot, bound to that contest. */
export interface ValidBallot {
  readonly ranking: readonly string[]
  readonly [validBallot]: true
}

// Which contest each ValidBallot was validated for, keyed by the exact frozen
// object validateBallot returned. The binding covers everything that decides
// how a ballot counts, the ruleset and the set of candidates, so a ballot
// validated for another contest is refused even when its ids and length fit.
// A WeakMap rather than a property on the ballot: a copy such as
// { ...ballot, ranking: [...] } or a hand-built object has no entry, so only
// the unmodified original is ever accepted for counting.
const boundContest = new WeakMap<ValidBallot, string>()

// Errors carry positions and counts, never candidate ids: a rejected ballot
// may end up in a log line or an HTTP response, and its content must not.
export type BallotError
  = | { readonly kind: 'malformed', readonly reason: 'not-an-array' | 'sparse-array' | 'non-string-entry' }
    | { readonly kind: 'inactive-slot', readonly activeSlots: number, readonly entries: number }
    | { readonly kind: 'incomplete', readonly activeSlots: number, readonly entries: number }
    | { readonly kind: 'unknown-candidate', readonly position: number }
    | { readonly kind: 'duplicate-candidate', readonly position: number }

export type BallotResult
  = | { readonly ok: true, readonly ballot: ValidBallot }
    | { readonly ok: false, readonly error: BallotError }

/** The ballot slots of a contest. Throws if the contest itself is invalid. */
export function contestSlots(contest: Contest): readonly Slot[] {
  if (!isRulesetId(contest.rulesetId)) {
    throw new TypeError('contest has an unknown ruleset id')
  }
  // Configuration comes from storage, not from the type checker; a contest
  // whose ids no ballot could ever name is a programming error.
  if (!isDenseNonEmptyStrings(contest.candidateIds)) {
    throw new TypeError('contest candidate ids must be a dense array of non-empty strings')
  }
  if (new Set(contest.candidateIds).size !== contest.candidateIds.length) {
    throw new TypeError('contest lists a candidate more than once')
  }
  return activeSlots(RULESETS[contest.rulesetId], contest.candidateIds.length)
}

export function validateBallot(contest: Contest, input: unknown): BallotResult {
  const slotCount = contestSlots(contest).length

  if (!Array.isArray(input)) return fail({ kind: 'malformed', reason: 'not-an-array' })
  // Checked before the entries so an oversized array is rejected without
  // walking it. With n candidates the (n+1)-th entry would fill a slot that
  // does not exist on this ballot, e.g. the 2-point slot with 4 candidates.
  if (input.length > slotCount) {
    return fail({ kind: 'inactive-slot', activeSlots: slotCount, entries: input.length })
  }

  const entries = input as unknown[]
  for (let i = 0; i < entries.length; i++) {
    if (!Object.hasOwn(entries, i)) return fail({ kind: 'malformed', reason: 'sparse-array' })
    if (typeof entries[i] !== 'string') return fail({ kind: 'malformed', reason: 'non-string-entry' })
  }
  const ranking = entries as string[]

  if (ranking.length < slotCount) {
    return fail({ kind: 'incomplete', activeSlots: slotCount, entries: ranking.length })
  }

  const candidates = new Set(contest.candidateIds)
  const seen = new Set<string>()
  for (const [position, id] of ranking.entries()) {
    if (!candidates.has(id)) return fail({ kind: 'unknown-candidate', position })
    if (seen.has(id)) return fail({ kind: 'duplicate-candidate', position })
    seen.add(id)
  }

  const ballot = Object.freeze({ ranking: Object.freeze([...ranking]) }) as unknown as ValidBallot
  boundContest.set(ballot, contestKey(contest))
  return { ok: true, ballot }
}

/**
 * Identifies a contest by what decides counting: ruleset and candidate set.
 * Display order is left out, since it does not change any score.
 */
export function contestKey(contest: Contest): string {
  return JSON.stringify([contest.rulesetId, [...contest.candidateIds].sort(compareCodeUnits)])
}

// Locale-independent, so the key is identical in Node and every browser.
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

export function isBallotFor(ballot: ValidBallot, key: string): boolean {
  return boundContest.get(ballot) === key
}

function isDenseNonEmptyStrings(values: unknown): boolean {
  if (!Array.isArray(values)) return false
  for (let i = 0; i < values.length; i++) {
    if (!Object.hasOwn(values, i)) return false
    const value: unknown = values[i]
    if (typeof value !== 'string' || value === '') return false
  }
  return true
}

function fail(error: BallotError): BallotResult {
  return { ok: false, error }
}
