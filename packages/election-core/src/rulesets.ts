// Statutory ballot rulesets.
//
// A ruleset is the fixed list of slots a ballot fills, in order. Each slot is
// one function the voter assigns a candidate to and the points that
// assignment carries; the two are the same thing seen from two sides. The
// Austrian tables come from the regulation on the election of school
// representatives (RIS Gesetzesnummer 10009897). Points are part of the
// ruleset, never input: no configuration can change them, and a contest with
// fewer candidates uses a prefix of the table instead of a rescaled one
// (docs/design.md explains why that is equivalent and still preferred).
//
// Ids carry a version. A ruleset is never edited in place: a change gets a
// new id, so results computed under the old one stay reproducible.

export type RulesetId = 'at-school-speaker-v1' | 'at-representative-v1' | 'single-choice-v1'

export interface Slot {
  /** 1-based position on the ballot; rank 1 is the highest slot. */
  readonly rank: number
  readonly points: number
  /** Stable key of the function this slot fills, for code and exports. */
  readonly function: string
  /** German label shown on the ballot. */
  readonly label: string
}

export interface Ruleset {
  readonly id: RulesetId
  readonly slots: readonly Slot[]
}

function ruleset(id: RulesetId, slots: readonly Omit<Slot, 'rank'>[]): Ruleset {
  return Object.freeze({
    id,
    slots: Object.freeze(slots.map((slot, index) => Object.freeze({ rank: index + 1, ...slot }))),
  })
}

export const RULESETS: Readonly<Record<RulesetId, Ruleset>> = Object.freeze({
  'at-school-speaker-v1': ruleset('at-school-speaker-v1', [
    { points: 6, function: 'school-speaker', label: 'Schulsprecher/in' },
    { points: 5, function: 'school-speaker-deputy-1', label: '1. Stellvertretung Schulsprecher/in' },
    { points: 4, function: 'school-speaker-deputy-2', label: '2. Stellvertretung Schulsprecher/in' },
    { points: 3, function: 'sga-deputy-1', label: '1. Stellvertretung im SGA' },
    { points: 2, function: 'sga-deputy-2', label: '2. Stellvertretung im SGA' },
    { points: 1, function: 'sga-deputy-3', label: '3. Stellvertretung im SGA' },
  ]),
  // Shared by class and department representatives: the same two slots.
  'at-representative-v1': ruleset('at-representative-v1', [
    { points: 2, function: 'representative', label: 'Vertreter/in' },
    { points: 1, function: 'deputy', label: 'Stellvertreter/in' },
  ]),
  // One choice per ballot: runoff rounds and anonymous single-choice polls.
  'single-choice-v1': ruleset('single-choice-v1', [
    { points: 1, function: 'choice', label: 'Stimme' },
  ]),
})

export function isRulesetId(value: unknown): value is RulesetId {
  return typeof value === 'string' && Object.hasOwn(RULESETS, value)
}

/**
 * The slots that exist on a ballot with `candidateCount` candidates: the first
 * min(candidateCount, slots) statutory slots. A valid vote fills every one of
 * them; slots beyond the candidate count are not on that ballot at all.
 */
export function activeSlots(ruleset: Ruleset, candidateCount: number): readonly Slot[] {
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 1) {
    throw new RangeError(`candidateCount must be a positive integer, got ${candidateCount}`)
  }
  return ruleset.slots.slice(0, Math.min(candidateCount, ruleset.slots.length))
}
