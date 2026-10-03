// Deputies and the other positions after the principal (§ 12 Abs. 4 to 6 of
// the regulation): the remaining functions of the ruleset go, in order, to the
// remaining candidates by their FIRST-round point totals. The principal's own
// points are left out and runoff votes never enter, so the runoff loser is not
// automatically a deputy. "Bei gleicher Punktezahl entscheidet das Los": a tie
// that decides who holds which position needs a lot, with no first-place or
// any other secondary comparison. Positions nobody is left for stay vacant.

import { RULESETS, type RulesetId } from './rulesets.ts'
import type { ContestStatistics } from './statistics.ts'
import { byValue, type LotRequest, type Position, type PositionsLot, type TraceStep } from './trace.ts'

export interface DerivedPositions {
  /** Every function of the ruleset in order, the principal first. */
  readonly positions: readonly Position[]
  /** Lots still to be drawn. */
  readonly lots: readonly LotRequest[]
  /** The derivation: the point comparison and every lot it requires. */
  readonly steps: readonly TraceStep[]
  /** The recorded lots that were applied. */
  readonly applied: readonly TraceStep[]
}

/** Returns the recorded order for a lot, or undefined while none is recorded. */
export type LotLookup = (lot: LotRequest) => readonly string[] | undefined

export function derivePositions(
  statistics: ContestStatistics,
  rulesetId: RulesetId,
  principal: { readonly candidateId: string, readonly basis: 'majority' | 'runoff' },
  lookup: LotLookup,
): DerivedPositions {
  const [head, ...functions] = RULESETS[rulesetId].slots.map((slot) => slot.function)
  const values = byValue(statistics.candidates
    .filter((c) => c.candidateId !== principal.candidateId)
    .map((c) => ({ candidateId: c.candidateId, value: c.points })))
  const derived: Position[] = []
  const lots: LotRequest[] = []
  const steps: TraceStep[] = [{ step: 'positions', excluded: principal.candidateId, values }]
  const applied: TraceStep[] = []

  let next = 0
  while (next < values.length && derived.length < functions.length) {
    const points = values[next]?.value
    const group = values.filter((v) => v.value === points).map((v) => v.candidateId)
    // Sorted, so the group is contiguous from `next`; the positions it
    // competes for start at the first one still open.
    const span = functions.slice(derived.length, derived.length + group.length)
    next += group.length
    if (group.length === 1) {
      derived.push({ function: span[0] ?? '', candidateId: group[0] ?? null, basis: 'points' })
      continue
    }
    const lot: PositionsLot = { id: `positions:${span[0] ?? ''}`, reason: 'positions', candidates: group, positions: span }
    steps.push({ step: 'lot-required', lot })
    const order = lookup(lot)
    if (order === undefined) lots.push(lot)
    else applied.push({ step: 'lot-applied', lotId: lot.id, order })
    span.forEach((fn, i) => derived.push(order === undefined
      ? { function: fn, candidateId: null, basis: 'lot-pending' }
      : { function: fn, candidateId: order[i] ?? null, basis: 'lot' }))
  }
  for (const fn of functions.slice(derived.length)) {
    derived.push({ function: fn, candidateId: null, basis: 'vacant' })
  }
  return { positions: [{ function: head ?? '', ...principal }, ...derived], lots, steps, applied }
}
