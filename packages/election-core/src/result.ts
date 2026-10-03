// The result of one round of one contest, computed from the configuration and
// the anonymous ballots alone. Every figure comes from computeStatistics, so
// the result does not depend on the order of the ballots, and every decision
// is made by an explicit comparison of counts: a tie never falls back to the
// name, id or list order of a candidate. Where the regulation leaves the
// decision to a lot or to people, the result says so and decides nothing.

import type { CastBallot, Contest } from './ballot.ts'
import { derivePositions } from './positions.ts'
import type { RulesetId } from './rulesets.ts'
import { computeStatistics, type ContestStatistics } from './statistics.ts'
import {
  byValue,
  countStep,
  type CandidateValue,
  type CommitteeReason,
  type LotRequest,
  type Position,
  type RunoffEntryLot,
  type TraceStep,
} from './trace.ts'

interface RoundResult {
  readonly contestId: string
  readonly rulesetId: RulesetId
  readonly statistics: ContestStatistics
  readonly trace: readonly TraceStep[]
}

type Committee = { readonly kind: 'committee-decision', readonly reason: CommitteeReason }

export type FirstRoundResult = RoundResult & (
  // `positions` and `lots` are the derived positions as far as the first
  // round decides them; resolve() applies recorded lots.
  | { readonly kind: 'elected', readonly winnerId: string, readonly positions: readonly Position[], readonly lots: readonly LotRequest[] }
  // In order of advancement; the runoff ballot lists them alphabetically.
  | { readonly kind: 'runoff-required', readonly runoffCandidates: readonly [string, string] }
  | { readonly kind: 'lot-required', readonly lot: RunoffEntryLot }
  | Committee
)

export type RunoffResult = RoundResult & {
  /** The first-round contest this runoff decides; null for a poll. */
  readonly runoffOf: string | null
} & (
  | { readonly kind: 'elected', readonly winnerId: string }
  // No statutory rule breaks a runoff tie: no winner and no lot.
  | { readonly kind: 'tie', readonly candidates: readonly string[] }
  | Committee
)

/**
 * The first round of a ranked contest (Schulsprecher, class or department
 * representative). Elected is only a candidate ranked first on more than half
 * of the valid ballots (§ 12 Abs. 3); otherwise the runoff pair is selected.
 */
export function firstRoundResult(contest: Contest, ballots: readonly CastBallot[]): FirstRoundResult {
  if (contest.rulesetId === 'single-choice-v1') throw new TypeError('a single-choice contest is counted by runoffResult')
  const statistics = computeStatistics(contest, ballots)
  const round = { contestId: contest.id, rulesetId: contest.rulesetId, statistics }
  const trace: TraceStep[] = [countStep(contest.id, statistics)]

  if (statistics.validBallots === 0) return committee(round, trace, 'no-valid-ballots')
  const winnerId = majority(statistics, trace)
  if (winnerId !== undefined) {
    const derived = derivePositions(statistics, contest.rulesetId, { candidateId: winnerId, basis: 'majority' }, () => undefined)
    return { ...round, kind: 'elected', winnerId, positions: derived.positions, lots: derived.lots, trace: [...trace, ...derived.steps] }
  }
  // With one candidate "Nein" won or drew level; a runoff is impossible.
  if (statistics.candidates.length === 1) return committee(round, trace, 'single-candidate-not-elected')

  // Only candidates tied on first places at the boundary are compared on
  // points, so more first places always beat more points; candidates tied on
  // both go to the lot.
  const qualified: string[] = []
  let contenders = statistics.candidates
  for (const basis of ['first-places', 'points'] as const) {
    const seats = 2 - qualified.length
    const values = byValue(contenders.map((c) => ({ candidateId: c.candidateId, value: basis === 'points' ? c.points : c.firstPlaces })))
    const { advancing, tied } = fill(values, seats)
    qualified.push(...advancing)
    trace.push({ step: 'compare', basis, seats, values, advancing, tied })
    if (tied.length === 0) {
      const runoffCandidates = qualified as [string, string]
      trace.push({ step: 'runoff', candidates: runoffCandidates })
      return { ...round, kind: 'runoff-required', runoffCandidates, trace }
    }
    contenders = contenders.filter((c) => tied.includes(c.candidateId))
  }
  const lot: RunoffEntryLot = {
    id: 'runoff-entry',
    reason: 'runoff-entry',
    candidates: contenders.map((c) => c.candidateId),
    seats: 2 - qualified.length,
    qualified,
  }
  trace.push({ step: 'lot-required', lot })
  return { ...round, kind: 'lot-required', lot, trace }
}

/**
 * A single-choice contest: the runoff of the first-round contest `runoffOf`,
 * where the candidate with more valid votes wins, or an anonymous poll
 * (`runoffOf` null), where the most votes win. A single option needs "Ja" on
 * more than half of the valid ballots, as in a first round. Naming the first
 * round explicitly keeps a poll, or the runoff of another contest with the
 * same candidates, from ever being applied as this contest's runoff.
 */
export function runoffResult(contest: Contest, ballots: readonly CastBallot[], runoffOf: string | null): RunoffResult {
  if (contest.rulesetId !== 'single-choice-v1') throw new TypeError('a ranked contest is counted by firstRoundResult')
  const statistics = computeStatistics(contest, ballots)
  const round = { contestId: contest.id, rulesetId: contest.rulesetId, statistics, runoffOf }
  const trace: TraceStep[] = [countStep(contest.id, statistics)]

  if (statistics.validBallots === 0) return committee(round, trace, 'no-valid-ballots')
  if (statistics.candidates.length === 1) {
    const winnerId = majority(statistics, trace)
    return winnerId === undefined
      ? committee(round, trace, 'single-candidate-not-elected')
      : { ...round, kind: 'elected', winnerId, trace }
  }
  const values = byValue(statistics.candidates.map((c) => ({ candidateId: c.candidateId, value: c.firstPlaces })))
  const { advancing, tied } = fill(values, 1)
  trace.push({ step: 'compare', basis: 'votes', seats: 1, values, advancing, tied })
  const [winnerId] = advancing
  return winnerId === undefined
    ? { ...round, kind: 'tie', candidates: tied, trace }
    : { ...round, kind: 'elected', winnerId, trace }
}

/** The candidate ranked first on more than half of the valid ballots, if any. */
function majority(statistics: ContestStatistics, trace: TraceStep[]): string | undefined {
  // At most one candidate can hold more than half of the first places.
  const winner = statistics.candidates.find((c) => 2 * c.firstPlaces > statistics.validBallots)
  trace.push({ step: 'majority', required: Math.floor(statistics.validBallots / 2) + 1, elected: winner?.candidateId ?? null })
  return winner?.candidateId
}

/**
 * Fills `seats` places from `values` (highest first) group by group. A group
 * of equal values that no longer fits is returned as `tied`; nothing below it
 * is considered.
 */
function fill(values: readonly CandidateValue[], seats: number): { advancing: string[], tied: string[] } {
  const advancing: string[] = []
  let next = 0
  while (advancing.length < seats && next < values.length) {
    const value = values[next]?.value
    const group = values.filter((v) => v.value === value).map((v) => v.candidateId)
    if (advancing.length + group.length > seats) return { advancing, tied: group }
    advancing.push(...group)
    next += group.length
  }
  return { advancing, tied: [] }
}

function committee<R extends Omit<RoundResult, 'trace'>>(round: R, trace: TraceStep[], reason: CommitteeReason) {
  trace.push({ step: 'committee-decision', reason })
  return { ...round, kind: 'committee-decision' as const, reason, trace }
}
