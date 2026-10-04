// From the stored round results and the recorded lot outcomes to the final
// positions of a contest. A lot is drawn by the election officials; the
// software only applies the outcome an authorised user recorded, and only to
// the lot it was recorded for: two ties between the same candidates, say for
// runoff entry and later for a deputy position, are two lots. resolve() reads
// its inputs and never changes them, so the first-round statistics the
// positions come from stay exactly as counted.

import { derivePositions, type DerivedPositions, type LotLookup } from './positions.ts'
import type { FirstRoundResult, RunoffResult } from './result.ts'
import { RULESETS } from './rulesets.ts'
import type { CommitteeReason, LotDecision, LotRequest, Position, TraceStep } from './trace.ts'

/** The kinds an outcome can have, for schemas and logs that name one. */
export const OUTCOME_KINDS = ['final', 'lot-required', 'runoff-required', 'tie', 'committee-decision'] as const
export type OutcomeKind = typeof OUTCOME_KINDS[number]

export type Outcome
  = | { readonly kind: 'final', readonly positions: readonly Position[], readonly trace: readonly TraceStep[] }
    // `positions` is empty while the runoff entry is open.
    | { readonly kind: 'lot-required', readonly lots: readonly LotRequest[], readonly positions: readonly Position[], readonly trace: readonly TraceStep[] }
    | { readonly kind: 'runoff-required', readonly runoffCandidates: readonly [string, string], readonly trace: readonly TraceStep[] }
    // A runoff tie, settled manually outside the software.
    | { readonly kind: 'tie', readonly candidates: readonly string[], readonly trace: readonly TraceStep[] }
    | { readonly kind: 'committee-decision', readonly reason: CommitteeReason, readonly trace: readonly TraceStep[] }

/**
 * Why a set of lot decisions was refused: a second decision for one lot, an
 * order that is not exactly the lot's tied set, or a lot that is not required.
 */
export interface LotDecisionError {
  readonly kind: 'duplicate-lot' | 'not-the-tied-set' | 'unknown-lot'
  readonly lotId: string
}

export type Resolution
  = | { readonly ok: true, readonly outcome: Outcome }
    | { readonly ok: false, readonly error: LotDecisionError }

class RefusedDecision extends Error {
  readonly refusal: LotDecisionError
  constructor(refusal: LotDecisionError) {
    super(refusal.kind)
    this.refusal = refusal
  }
}

/**
 * Applies the runoff result, if the first round required one, and the
 * recorded lots. Throws a TypeError if the runoff does not belong to the
 * first round; refuses lot decisions with a typed error.
 */
export function resolve(
  firstRound: FirstRoundResult,
  runoff: RunoffResult | undefined,
  decisions: readonly LotDecision[],
): Resolution {
  const recorded = new Map<string, readonly string[]>()
  for (const { lotId, order } of decisions) {
    if (recorded.has(lotId)) return { ok: false, error: { kind: 'duplicate-lot', lotId } }
    recorded.set(lotId, order)
  }
  const used = new Set<string>()
  const lookup: LotLookup = (lot) => {
    const order = recorded.get(lot.id)
    if (order === undefined) return undefined
    if (!isOrderOf(order, lot.candidates)) throw new RefusedDecision({ kind: 'not-the-tied-set', lotId: lot.id })
    used.add(lot.id)
    return [...order]
  }
  try {
    const outcome = outcomeOf(firstRound, runoff, lookup)
    const unused = [...recorded.keys()].find((lotId) => !used.has(lotId))
    return unused === undefined ? { ok: true, outcome } : { ok: false, error: { kind: 'unknown-lot', lotId: unused } }
  } catch (error) {
    if (error instanceof RefusedDecision) return { ok: false, error: error.refusal }
    throw error
  }
}

/**
 * The outcome of an anonymous single-choice poll, which has no runoff and
 * no lots: its result as it is. The one function of the ruleset goes to
 * the choice, by a majority of "Ja" against a single option, or by the
 * most valid votes among several.
 */
export function pollOutcome(poll: RunoffResult): Outcome {
  if (poll.runoffOf !== null) throw new TypeError('a runoff is resolved with its first round')
  const trace = [...poll.trace]
  switch (poll.kind) {
    case 'elected': {
      const choice = RULESETS['single-choice-v1'].slots[0]?.function ?? 'choice'
      const basis = poll.statistics.candidates.length === 1 ? 'majority' : 'votes'
      return { kind: 'final', positions: [{ function: choice, candidateId: poll.winnerId, basis }], trace }
    }
    case 'tie':
      return { kind: 'tie', candidates: poll.candidates, trace }
    case 'committee-decision':
      return { kind: 'committee-decision', reason: poll.reason, trace }
  }
}

function outcomeOf(first: FirstRoundResult, runoff: RunoffResult | undefined, lookup: LotLookup): Outcome {
  const trace = [...first.trace]
  switch (first.kind) {
    case 'committee-decision':
      noRunoff(runoff, 'the first round required no runoff')
      return { kind: first.kind, reason: first.reason, trace }
    case 'elected': {
      noRunoff(runoff, 'the first round required no runoff')
      const derived = derivePositions(first.statistics, first.rulesetId, { candidateId: first.winnerId, basis: 'majority' }, lookup)
      // The first-round trace already holds the derivation and its lot requests.
      return positionsOutcome(derived, [...trace, ...derived.applied])
    }
    case 'runoff-required':
      return afterRunoff(first, first.runoffCandidates, runoff, trace, lookup)
    case 'lot-required': {
      const order = lookup(first.lot)
      if (order === undefined) {
        noRunoff(runoff, 'the runoff pair is not decided yet')
        return { kind: 'lot-required', lots: [first.lot], positions: [], trace }
      }
      const pair = [...first.lot.qualified, ...order.slice(0, first.lot.seats)] as [string, string]
      trace.push({ step: 'lot-applied', lotId: first.lot.id, order }, { step: 'runoff', candidates: pair })
      return afterRunoff(first, pair, runoff, trace, lookup)
    }
  }
}

function afterRunoff(
  first: FirstRoundResult,
  pair: readonly [string, string],
  runoff: RunoffResult | undefined,
  trace: TraceStep[],
  lookup: LotLookup,
): Outcome {
  if (runoff === undefined) return { kind: 'runoff-required', runoffCandidates: pair, trace }
  const runoffIds = runoff.statistics.candidates.map((c) => c.candidateId)
  if (runoff.runoffOf !== first.contestId || runoff.rulesetId !== 'single-choice-v1' || !isOrderOf(runoffIds, pair)) {
    throw new TypeError('the runoff result is not the runoff of this contest and its pair')
  }
  trace.push(...runoff.trace)
  switch (runoff.kind) {
    case 'tie':
      return { kind: 'tie', candidates: runoff.candidates, trace }
    case 'committee-decision':
      return { kind: runoff.kind, reason: runoff.reason, trace }
    case 'elected': {
      // The runoff decides only who the principal is; every other position
      // comes from the first-round points.
      const derived = derivePositions(first.statistics, first.rulesetId, { candidateId: runoff.winnerId, basis: 'runoff' }, lookup)
      return positionsOutcome(derived, [...trace, ...derived.steps, ...derived.applied])
    }
  }
}

function noRunoff(runoff: RunoffResult | undefined, message: string): void {
  if (runoff !== undefined) throw new TypeError(message)
}

function positionsOutcome(derived: DerivedPositions, trace: readonly TraceStep[]): Outcome {
  const { positions, lots } = derived
  return lots.length > 0 ? { kind: 'lot-required', lots, positions, trace } : { kind: 'final', positions, trace }
}

/**
 * Whether `order` lists every member of `set` exactly once and nothing else.
 * Checked index by index, so a hole in a sparse array is refused rather than
 * skipped as every() would.
 */
function isOrderOf(order: readonly unknown[], set: readonly string[]): boolean {
  if (!Array.isArray(order) || order.length !== set.length) return false
  const seen = new Set<string>()
  for (let i = 0; i < order.length; i++) {
    const id: unknown = Object.hasOwn(order, i) ? order[i] : undefined
    if (typeof id !== 'string' || !set.includes(id) || seen.has(id)) return false
    seen.add(id)
  }
  return true
}
