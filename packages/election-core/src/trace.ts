// The vocabulary of a result: positions, lot requests and decisions, and the
// trace that explains every step of the derivation with its numbers. All of
// it is plain, language-neutral data, so a stored result can be shown to
// witnesses, exported and re-checked; the web app renders it in German.

import type { ContestStatistics } from './statistics.ts'

/** A candidate with the figure a step compared: first places, points or votes. */
export interface CandidateValue {
  readonly candidateId: string
  readonly value: number
}

/** Why a contest has no winner the software may name, and the school committee decides. */
export type CommitteeReason = 'no-valid-ballots' | 'single-candidate-not-elected'

/**
 * A tie only a lot drawn by the election officials can break. `candidates` is
 * the tied set, in contest order; a decision orders exactly this set.
 */
export type LotRequest = RunoffEntryLot | PositionsLot

export interface RunoffEntryLot {
  readonly id: 'runoff-entry'
  readonly reason: 'runoff-entry'
  readonly candidates: readonly string[]
  /** How many of the tied candidates enter the runoff: the first `seats` in the drawn order. */
  readonly seats: number
  /** Who entered the runoff without the lot. */
  readonly qualified: readonly string[]
}

export interface PositionsLot {
  readonly id: `positions:${string}`
  readonly reason: 'positions'
  readonly candidates: readonly string[]
  /** The positions the draw fills, in order: the first drawn takes the first. */
  readonly positions: readonly string[]
}

/** A recorded lot outcome: every candidate of the lot's tied set once, in the order drawn. */
export interface LotDecision {
  readonly lotId: string
  readonly order: readonly string[]
}

/**
 * One function of the contest and who holds it. `function` is the ruleset's
 * slot function. `candidateId` is null while a lot is pending and when no
 * candidate is left to hold the position.
 */
export interface Position {
  readonly function: string
  readonly candidateId: string | null
  readonly basis: 'majority' | 'runoff' | 'points' | 'lot' | 'lot-pending' | 'vacant'
}

export type TraceStep
  // The ballots of one contest: the start of each round's derivation.
  = | { readonly step: 'count', readonly contestId: string, readonly ballotsCast: number, readonly validBallots: number, readonly noBallots: number, readonly invalidBallots: number }
    // More than half of the valid ballots: `required` first places at least.
    | { readonly step: 'majority', readonly required: number, readonly elected: string | null }
    // `seats` places among `values`, highest first: `advancing` take places
    // outright, `tied` share the value at the boundary and do not all fit.
    | { readonly step: 'compare', readonly basis: 'first-places' | 'points' | 'votes', readonly seats: number, readonly values: readonly CandidateValue[], readonly advancing: readonly string[], readonly tied: readonly string[] }
    | { readonly step: 'runoff', readonly candidates: readonly [string, string] }
    // Deputy and other positions by first-round points, without the principal.
    | { readonly step: 'positions', readonly excluded: string, readonly values: readonly CandidateValue[] }
    | { readonly step: 'lot-required', readonly lot: LotRequest }
    | { readonly step: 'lot-applied', readonly lotId: string, readonly order: readonly string[] }
    | { readonly step: 'committee-decision', readonly reason: CommitteeReason }

export function countStep(contestId: string, statistics: ContestStatistics): TraceStep {
  const { validBallots, noBallots, invalidBallots } = statistics
  return { step: 'count', contestId, ballotsCast: validBallots + invalidBallots, validBallots, noBallots, invalidBallots }
}

/**
 * Highest value first. The sort is stable, so equal values keep contest
 * order: that order is only how a tie is listed, never how it is decided.
 */
export function byValue(values: readonly CandidateValue[]): readonly CandidateValue[] {
  return values.toSorted((a, b) => b.value - a.value)
}
