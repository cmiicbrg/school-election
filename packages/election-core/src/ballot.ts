// Ballot validation: the single authority on what may be cast.
//
// A ballot comes in one of three explicit forms:
//
// - { kind: 'ranking', ranking }: an ordered array of candidate ids. Index 0
//   fills the highest slot, index 1 the next, and so on; the slot, and with
//   it the points, follows from the position alone, so the form cannot
//   express a duplicate slot or a skipped one. It must fill every active
//   slot with a distinct candidate: a voter cannot award the top points and
//   withhold the rest, because the lower positions decide deputies and
//   runoff tiebreaks. A partly filled or empty ranking is rejected.
// - { kind: 'no' }: "Nein", offered only when a contest has a single
//   candidate, so that voters can vote against them. A valid vote.
// - { kind: 'blank' }: a deliberate blank ballot, possible in every contest.
//   It is cast and counted, but it is an invalid vote: it gives nobody points
//   or a first place and is not part of the majority base. Because it has its
//   own form, an untouched or truncated ranking can never turn into one.

import { activeSlots, isRulesetId, RULESETS, type RulesetId, type Slot } from './rulesets.ts'

export interface Contest {
  /** Stable identity of this contest in its round, e.g. its database id. */
  readonly id: string
  readonly rulesetId: RulesetId
  /** Every candidate standing in this contest, in display order. */
  readonly candidateIds: readonly string[]
}

export type BallotKind = 'ranking' | 'no' | 'blank'

declare const validBallot: unique symbol

/**
 * A ballot accepted by validateBallot and bound to that contest. `ranking`
 * holds the complete ranking for kind 'ranking' and is empty otherwise.
 */
export interface CastBallot {
  readonly kind: BallotKind
  readonly ranking: readonly string[]
  readonly [validBallot]: true
}

// Which contest each CastBallot was validated for, keyed by the exact frozen
// object validateBallot returned. The binding covers the contest's identity
// and everything that decides how a ballot counts, the ruleset and the set
// of candidates, so a ballot is refused by any other contest, even one with
// the same configuration. A WeakMap rather than a property on the ballot: a
// copy such as { ...ballot, ranking: [...] } or a hand-built object has no
// entry, so only the unmodified original is ever accepted for counting.
const boundContest = new WeakMap<CastBallot, string>()

// Errors carry positions and counts, never candidate ids: a rejected ballot
// may end up in a log line or an HTTP response, and its content must not.
export type BallotError
  = | { readonly kind: 'malformed', readonly reason: 'unknown-form' | 'not-an-array' | 'sparse-array' | 'non-string-entry' }
    | { readonly kind: 'no-not-offered' }
    | { readonly kind: 'inactive-slot', readonly activeSlots: number, readonly entries: number }
    | { readonly kind: 'incomplete', readonly activeSlots: number, readonly entries: number }
    | { readonly kind: 'unknown-candidate', readonly position: number }
    | { readonly kind: 'duplicate-candidate', readonly position: number }

export type BallotResult
  = | { readonly ok: true, readonly ballot: CastBallot }
    | { readonly ok: false, readonly error: BallotError }

/** The ballot slots of a contest. Throws if the contest itself is invalid. */
export function contestSlots(contest: Contest): readonly Slot[] {
  const id: unknown = contest.id
  if (typeof id !== 'string' || id === '') {
    throw new TypeError('contest id must be a non-empty string')
  }
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

/** Whether the contest offers "Nein": only with a single candidate. */
export function offersNo(contest: Contest): boolean {
  return contest.candidateIds.length === 1
}

export function validateBallot(contest: Contest, input: unknown): BallotResult {
  const slotCount = contestSlots(contest).length

  switch (formOf(input)) {
    case 'blank':
      return cast(contest, 'blank', [])
    case 'no':
      return offersNo(contest) ? cast(contest, 'no', []) : fail({ kind: 'no-not-offered' })
    case 'ranking': {
      const checked = checkRanking(contest, slotCount, (input as { ranking?: unknown }).ranking)
      return 'error' in checked ? fail(checked.error) : cast(contest, 'ranking', checked.ranking)
    }
    default:
      return fail({ kind: 'malformed', reason: 'unknown-form' })
  }
}

function formOf(input: unknown): BallotKind | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  if (!Object.hasOwn(input, 'kind')) return undefined
  const kind = (input as { kind: unknown }).kind
  return kind === 'ranking' || kind === 'no' || kind === 'blank' ? kind : undefined
}

function checkRanking(
  contest: Contest,
  slotCount: number,
  input: unknown,
): { readonly ranking: readonly string[] } | { readonly error: BallotError } {
  if (!Array.isArray(input)) return { error: { kind: 'malformed', reason: 'not-an-array' } }
  // Checked before the entries so an oversized array is rejected without
  // walking it. With n candidates the (n+1)-th entry would fill a slot that
  // does not exist on this ballot, e.g. the 2-point slot with 4 candidates.
  if (input.length > slotCount) {
    return { error: { kind: 'inactive-slot', activeSlots: slotCount, entries: input.length } }
  }

  const entries = input as unknown[]
  for (let i = 0; i < entries.length; i++) {
    if (!Object.hasOwn(entries, i)) return { error: { kind: 'malformed', reason: 'sparse-array' } }
    if (typeof entries[i] !== 'string') return { error: { kind: 'malformed', reason: 'non-string-entry' } }
  }
  const ranking = entries as string[]

  if (ranking.length < slotCount) {
    return { error: { kind: 'incomplete', activeSlots: slotCount, entries: ranking.length } }
  }

  const candidates = new Set(contest.candidateIds)
  const seen = new Set<string>()
  for (const [position, id] of ranking.entries()) {
    if (!candidates.has(id)) return { error: { kind: 'unknown-candidate', position } }
    if (seen.has(id)) return { error: { kind: 'duplicate-candidate', position } }
    seen.add(id)
  }
  return { ranking }
}

function cast(contest: Contest, kind: BallotKind, ranking: readonly string[]): BallotResult {
  const ballot = Object.freeze({ kind, ranking: Object.freeze([...ranking]) }) as unknown as CastBallot
  boundContest.set(ballot, contestKey(contest))
  return { ok: true, ballot }
}

/**
 * Identifies a contest by its id and by what decides counting: ruleset and
 * candidate set. Display order is left out, since it does not change any
 * score.
 */
export function contestKey(contest: Contest): string {
  return JSON.stringify([contest.id, contest.rulesetId, [...contest.candidateIds].sort(compareCodeUnits)])
}

// Locale-independent, so the key is identical in Node and every browser.
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

export function isBallotFor(ballot: CastBallot, key: string): boolean {
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
