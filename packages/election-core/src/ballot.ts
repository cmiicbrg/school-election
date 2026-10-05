// Ballot validation: the single authority on what may be cast.
//
// A ballot comes in one of two forms:
//
// - { kind: 'ranking', ranking, confirmInvalid? }: the slots as the voter
//   left them. Index 0 is the highest slot, index 1 the next, and so on;
//   each entry is a candidate id or null for a slot left empty. The slot,
//   and with it the points, follows from the position alone, so the form
//   cannot express two candidates in one slot.
//   With every active slot filled by distinct candidates the ballot is a
//   valid vote. With one or more slots left empty it is an invalid vote:
//   it gives nobody points or a first place, so nobody can award the top
//   points and withhold the rest, and it is not part of the majority base.
//   Leaving slots empty is the voter's right ("weiß wählen"), but an invalid
//   vote is cast only with confirmInvalid: true; otherwise it is refused as
//   incomplete, so the client has to ask the voter first.
// - { kind: 'no' }: "Nein", offered only when a contest has a single
//   candidate, so that voters can vote against them. A valid vote.
//
// Entries a correct client cannot produce, such as an unknown or repeated
// candidate or a slot that does not exist, are refused, never cast.

import { activeSlots, isRulesetId, RULESETS, type RulesetId, type Slot } from './rulesets.ts'

export interface Contest {
  /** Stable identity of this contest in its round, e.g. its database id. */
  readonly id: string
  readonly rulesetId: RulesetId
  /** Every candidate standing in this contest, in display order. */
  readonly candidateIds: readonly string[]
}

/** 'ranking' and 'no' are valid votes, 'invalid' is a confirmed invalid vote. */
export const BALLOT_KINDS = ['ranking', 'no', 'invalid'] as const
export type BallotKind = typeof BALLOT_KINDS[number]

/**
 * A ballot accepted by validateBallot, carrying the contest it was validated
 * for: `contestKey` names the contest's identity and everything that decides
 * how a ballot counts, the ruleset and the set of candidates (contestKey),
 * so a ballot is refused by any other contest, even one with the same
 * configuration (isBallotFor). `ranking` holds the complete ranking for kind
 * 'ranking' and is empty otherwise: an invalid vote counts only as invalid,
 * so its partial content is not kept.
 */
export interface CastBallot {
  readonly kind: BallotKind
  readonly ranking: readonly string[]
  readonly contestKey: string
}

// Errors carry positions and counts, never candidate ids: a rejected ballot
// may end up in a log line or an HTTP response, and its content must not.
export type BallotError
  = | { readonly kind: 'malformed', readonly reason: 'unknown-form' | 'not-an-array' | 'invalid-entry' }
    | { readonly kind: 'no-not-offered' }
    | { readonly kind: 'inactive-slot', readonly activeSlots: number, readonly entries: number }
    | { readonly kind: 'incomplete', readonly activeSlots: number, readonly filled: number }
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
    case 'no':
      return offersNo(contest) ? cast(contest, 'no', []) : fail({ kind: 'no-not-offered' })
    case 'ranking': {
      // formOf returned a form, so input is a non-array object.
      const { ranking, confirmInvalid } = input as { ranking?: unknown, confirmInvalid?: unknown }
      const checked = checkRanking(contest, slotCount, ranking)
      if ('error' in checked) return fail(checked.error)
      if (checked.filled === slotCount) return cast(contest, 'ranking', checked.ranking)
      return confirmInvalid === true
        ? cast(contest, 'invalid', [])
        : fail({ kind: 'incomplete', activeSlots: slotCount, filled: checked.filled })
    }
    default:
      return fail({ kind: 'malformed', reason: 'unknown-form' })
  }
}

function formOf(input: unknown): 'ranking' | 'no' | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const { kind } = input as { kind?: unknown }
  return kind === 'ranking' || kind === 'no' ? kind : undefined
}

function checkRanking(
  contest: Contest,
  slotCount: number,
  input: unknown,
): { readonly ranking: readonly string[], readonly filled: number } | { readonly error: BallotError } {
  if (!Array.isArray(input)) return { error: { kind: 'malformed', reason: 'not-an-array' } }
  // Checked before the entries so an oversized array is rejected without
  // walking it. With n candidates the (n+1)-th entry would fill a slot that
  // does not exist on this ballot, e.g. the 2-point slot with 4 candidates.
  if (input.length > slotCount) {
    return { error: { kind: 'inactive-slot', activeSlots: slotCount, entries: input.length } }
  }

  const candidates = new Set(contest.candidateIds)
  const seen = new Set<string>()
  const entries = input as unknown[]
  for (const [position, entry] of entries.entries()) {
    if (entry === null) continue
    if (typeof entry !== 'string') return { error: { kind: 'malformed', reason: 'invalid-entry' } }
    if (!candidates.has(entry)) return { error: { kind: 'unknown-candidate', position } }
    if (seen.has(entry)) return { error: { kind: 'duplicate-candidate', position } }
    seen.add(entry)
  }
  return { ranking: [...entries] as string[], filled: seen.size }
}

/** The ballot as the contest accepted it: a frozen copy of the ranking, and the contest it is for. */
function cast(contest: Contest, kind: BallotKind, ranking: readonly string[]): BallotResult {
  const ballot: CastBallot = Object.freeze({ kind, ranking: Object.freeze([...ranking]), contestKey: contestKey(contest) })
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

/** Whether the ballot was validated for the contest with this key (contestKey). */
export function isBallotFor(ballot: CastBallot, key: string): boolean {
  return ballot.contestKey === key
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
