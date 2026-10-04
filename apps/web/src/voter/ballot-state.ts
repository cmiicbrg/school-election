// One contest's ballot as the voter fills it, free of Vue: the active rows
// from the top, a candidate or nothing in each, every candidate in at most
// one row. What the review step says and what is sent come from here and
// from election-core's own validation of exactly that, so the page and the
// API never disagree on whether a vote is valid.

import { validateBallot } from '@school-election/election-core'
import type { RankingBallot, VoterBallot, VoterCandidate, VoterContest } from './voter-api.ts'
import { coreContest, slotRows } from './voter-rules.ts'

export interface BallotState {
  /** A candidate id or null, one per active row, from the top. */
  readonly slots: readonly (string | null)[]
}

export function emptyBallot(contest: Pick<VoterContest, 'rulesetId' | 'candidates'>): BallotState {
  return { slots: slotRows(contest).map(() => null) }
}

/** The rows of a ranking, if it has as many as the ballot; for anything else the empty ballot. */
export function fromBallot(contest: Pick<VoterContest, 'rulesetId' | 'candidates'>, ballot: VoterBallot | undefined): BallotState {
  const empty = emptyBallot(contest)
  if (ballot?.kind !== 'ranking' || ballot.ranking.length !== empty.slots.length) return empty
  return { slots: [...ballot.ranking] }
}

/** Puts the candidate, or nothing, into the row at `rank` (1-based); a candidate sitting in another row moves. */
export function place(state: BallotState, rank: number, candidateId: string | null): BallotState {
  if (!Number.isInteger(rank) || rank < 1 || rank > state.slots.length) throw new RangeError(`no row ${rank} on a ballot of ${state.slots.length}`)
  const slots = state.slots.map((id) => (candidateId !== null && id === candidateId ? null : id))
  slots[rank - 1] = candidateId
  return { slots }
}

/** The row (1-based) a candidate sits in, or undefined. */
export function rowOf(state: BallotState, candidateId: string): number | undefined {
  const index = state.slots.indexOf(candidateId)
  return index === -1 ? undefined : index + 1
}

/** The candidates in no row, in ballot order: with more candidates than rows, those who get no points. */
export function pool(contest: Pick<VoterContest, 'candidates'>, state: BallotState): VoterCandidate[] {
  return contest.candidates.filter((candidate) => !state.slots.includes(candidate.id))
}

/** The ranking as it stands, to be reviewed; the confirmation is added only when the review calls for it. */
export function rankingOf(state: BallotState): RankingBallot {
  return { kind: 'ranking', ranking: [...state.slots] }
}

export type Review
  = | { kind: 'valid' }
    | { kind: 'invalid', empty: number, of: number }
    | { kind: 'no' }

/**
 * What election-core says about the ballot to be sent: a valid vote, an
 * invalid one (an incomplete ranking, which only the voter's confirmation
 * sends), or "Nein". The page builds no ballot election-core would refuse
 * for any other reason; one would be a programming error.
 */
export function review(contest: Pick<VoterContest, 'id' | 'rulesetId' | 'candidates'>, ballot: VoterBallot): Review {
  if (ballot.kind === 'no') return { kind: 'no' }
  const result = validateBallot(coreContest(contest), { kind: 'ranking', ranking: [...ballot.ranking] })
  if (result.ok) return { kind: 'valid' }
  if (result.error.kind === 'incomplete') {
    return { kind: 'invalid', empty: result.error.activeSlots - result.error.filled, of: result.error.activeSlots }
  }
  throw new Error(`the page built a ballot election-core refuses: ${result.error.kind}`)
}

/** The body to send: the ballot as reviewed, with the voter's confirmation when the review said invalid. */
export function toSend(ballot: VoterBallot, confirmInvalid: boolean): VoterBallot {
  if (ballot.kind === 'no') return ballot
  const { confirmInvalid: _dropped, ...ranking } = ballot
  return confirmInvalid ? { ...ranking, confirmInvalid: true } : ranking
}
