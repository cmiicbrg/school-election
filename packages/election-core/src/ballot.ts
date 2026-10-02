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

export type CandidateId = string

export interface Contest {
  readonly rulesetId: RulesetId
  /** Every candidate standing in this contest, in display order. */
  readonly candidateIds: readonly CandidateId[]
}

declare const validBallot: unique symbol

/**
 * A ballot that passed validateBallot for its contest. The brand keeps
 * unvalidated arrays out of the tally at compile time.
 */
export interface ValidBallot {
  readonly ranking: readonly CandidateId[]
  readonly [validBallot]: true
}

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

  return { ok: true, ballot: { ranking: Object.freeze([...ranking]) } as unknown as ValidBallot }
}

function fail(error: BallotError): BallotResult {
  return { ok: false, error }
}
