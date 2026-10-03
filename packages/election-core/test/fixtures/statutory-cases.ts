// One entry per confirmed row of the statutory rulings table in
// docs/design.md, keyed by the row's case text verbatim, so the committee can
// check its rulings against `npm test`. A test keeps the two in step: a row
// without fixtures, or fixtures without a row, fail it.

import type { CommitteeReason, LotDecision } from '../../src/index.ts'
import type { BallotSpec } from '../helpers/ballots.ts'

type Rows = readonly (readonly [number, BallotSpec])[]

export interface StatutoryExample {
  readonly name: string
  readonly rulesetId: 'at-school-speaker-v1' | 'at-representative-v1'
  readonly candidates: readonly string[]
  readonly ballots: Rows
  /** Runoff ballots; the runoff contest holds the pair the first round selected. */
  readonly runoff?: Rows
  readonly lots?: readonly LotDecision[]
  readonly expected:
    // Holder per position; null is vacant.
    | { readonly kind: 'final', readonly positions: Readonly<Record<string, string | null>> }
    | { readonly kind: 'lot-required', readonly lots: readonly { readonly id: string, readonly candidates: readonly string[] }[] }
    | { readonly kind: 'runoff-required', readonly runoffCandidates: readonly string[] }
    | { readonly kind: 'tie', readonly candidates: readonly string[] }
    | { readonly kind: 'committee-decision', readonly reason: CommitteeReason }
}

const speaker = (holders: readonly (string | null)[]) => Object.fromEntries(
  ['school-speaker', 'school-speaker-deputy-1', 'school-speaker-deputy-2', 'sga-deputy-1', 'sga-deputy-2', 'sga-deputy-3']
    .map((fn, i) => [fn, holders[i] ?? null]),
)
const representative = (holder: string, deputy: string | null) => ({ representative: holder, deputy })

// Alice 41 first places, Bob and Carol 32 each; Bob 287 points, Carol 271.
// d has no first place but the most points: 491, then e 385, f 280.
const EIGHT = ['alice', 'bob', 'carol', 'd', 'e', 'f', 'g', 'h']
const TIE_FOR_SECOND: Rows = [
  [19, ['alice', 'bob', 'd', 'e', 'f', 'g']],
  [15, ['alice', 'carol', 'd', 'e', 'f', 'g']],
  [1, ['alice', 'd', 'carol', 'e', 'f', 'g']],
  [6, ['alice', 'd', 'e', 'f', 'g', 'h']],
  [32, ['bob', 'd', 'e', 'f', 'g', 'h']],
  [32, ['carol', 'd', 'e', 'f', 'g', 'h']],
]
// a leads; b and c are equal on first places (1) and points (19).
const ENTRY_LOT: Rows = [[1, ['a', 'b', 'c']], [1, ['a', 'c', 'b']], [1, ['b', 'a', 'c']], [1, ['c', 'a', 'b']]]
// Class: a elected; b (2 first places, 4 points) and c (none, 4 points) tie for deputy.
const DEPUTY_TIE: Rows = [[4, ['a', 'c']], [2, ['b', 'a']]]

export const STATUTORY_CASES: readonly { readonly ruling: string, readonly examples: readonly StatutoryExample[] }[] = [
  {
    ruling: 'Who is elected in round 1, for every representative (Klassen- or Jahrgangssprecher, Vertreter der Klassensprecher, Abteilungs-, Tages- and Schulsprecher)',
    examples: [
      { name: '51 of 100 first places: elected', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c'], ballots: [[51, ['a', 'b', 'c']], [49, ['b', 'c', 'a']]], expected: { kind: 'final', positions: speaker(['a', 'b', 'c']) } },
      { name: '50 of 100 first places: no majority', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c'], ballots: [[50, ['a', 'b', 'c']], [30, ['b', 'c', 'a']], [20, ['c', 'a', 'b']]], expected: { kind: 'runoff-required', runoffCandidates: ['a', 'b'] } },
      { name: '50 of 99 first places: elected', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c'], ballots: [[50, ['a', 'b', 'c']], [49, ['b', 'c', 'a']]], expected: { kind: 'final', positions: speaker(['a', 'b', 'c']) } },
      // a: 3 first places, 24 points; c: no first place, 25 points.
      { name: 'counted from first places, not points', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c', 'd'], ballots: [[3, ['a', 'c', 'd', 'b']], [2, ['b', 'c', 'd', 'a']]], expected: { kind: 'final', positions: speaker(['a', 'c', 'b', 'd']) } },
    ],
  },
  {
    ruling: 'Base of "more than half"',
    examples: [
      { name: 'invalid votes do not count: 5 of 9 valid ballots, 6 invalid', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c'], ballots: [[5, ['a', 'b', 'c']], [4, ['b', 'a', 'c']], [6, 'invalid']], expected: { kind: 'final', positions: speaker(['a', 'b', 'c']) } },
      { name: '"Nein" counts: 5 "Ja" of 10 valid ballots', rulesetId: 'at-school-speaker-v1', candidates: ['a'], ballots: [[5, ['a']], [5, 'no'], [3, 'invalid']], expected: { kind: 'committee-decision', reason: 'single-candidate-not-elected' } },
    ],
  },
  {
    ruling: 'Two candidates with exactly 50 % of first places each',
    examples: [
      { name: 'two candidates, 3 to 3', rulesetId: 'at-representative-v1', candidates: ['a', 'b'], ballots: [[3, ['a', 'b']], [3, ['b', 'a']]], expected: { kind: 'runoff-required', runoffCandidates: ['a', 'b'] } },
      { name: 'points play no part: 30 and 33 points', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c'], ballots: [[3, ['a', 'b', 'c']], [3, ['b', 'c', 'a']]], expected: { kind: 'runoff-required', runoffCandidates: ['a', 'b'] } },
    ],
  },
  {
    ruling: 'More than two candidates would enter the runoff on first places',
    examples: [
      { name: '41, 32, 32 first places: 287 points beat 271', rulesetId: 'at-school-speaker-v1', candidates: EIGHT, ballots: TIE_FOR_SECOND, expected: { kind: 'runoff-required', runoffCandidates: ['alice', 'bob'] } },
      { name: 'equal on points as well: lot', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c'], ballots: ENTRY_LOT, expected: { kind: 'lot-required', lots: [{ id: 'runoff-entry', candidates: ['b', 'c'] }] } },
      { name: 'the recorded lot decides entry', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c'], ballots: ENTRY_LOT, lots: [{ lotId: 'runoff-entry', order: ['c', 'b'] }], expected: { kind: 'runoff-required', runoffCandidates: ['a', 'c'] } },
      // b: 2 first places, 22 points; c: 1 first place, 36 points.
      { name: 'more first places are never displaced on points', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c', 'd', 'e'], ballots: [[3, ['a', 'c', 'd', 'e', 'b']], [2, ['b', 'c', 'd', 'e', 'a']], [1, ['c', 'd', 'e', 'a', 'b']], [1, ['d', 'c', 'e', 'a', 'b']]], expected: { kind: 'runoff-required', runoffCandidates: ['a', 'b'] } },
    ],
  },
  {
    ruling: 'Who wins the runoff, and a tie in the runoff',
    examples: [
      { name: 'more valid votes win', rulesetId: 'at-school-speaker-v1', candidates: EIGHT, ballots: TIE_FOR_SECOND, runoff: [[40, ['alice']], [60, ['bob']], [3, 'invalid']], expected: { kind: 'final', positions: speaker(['bob', 'd', 'e', 'f', 'carol', 'alice']) } },
      { name: 'a tie: no winner and no lot', rulesetId: 'at-school-speaker-v1', candidates: EIGHT, ballots: TIE_FOR_SECOND, runoff: [[50, ['alice']], [50, ['bob']]], expected: { kind: 'tie', candidates: ['alice', 'bob'] } },
    ],
  },
  {
    ruling: 'Deputies and SGA substitutes',
    examples: [
      // b 35, c 25, d 24, g 18, e 11, f 10 points; a won with 24.
      { name: 'Schulsprecher elected in round 1', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], ballots: [[4, ['a', 'b', 'c', 'd', 'e', 'f']], [3, ['g', 'b', 'd', 'c', 'f', 'e']]], expected: { kind: 'final', positions: speaker(['a', 'b', 'c', 'd', 'g', 'e']) } },
      { name: 'after a runoff: first-round points, the runoff loser no automatic deputy', rulesetId: 'at-school-speaker-v1', candidates: EIGHT, ballots: TIE_FOR_SECOND, runoff: [[1, ['alice']], [2, ['bob']]], expected: { kind: 'final', positions: speaker(['bob', 'd', 'e', 'f', 'carol', 'alice']) } },
      // c has 6 points and 1 first place, b 5 points and 2 first places.
      { name: 'class representative: the deputy has the highest total', rulesetId: 'at-representative-v1', candidates: ['a', 'b', 'c'], ballots: [[4, ['a', 'c']], [2, ['b', 'a']], [1, ['c', 'b']]], expected: { kind: 'final', positions: representative('a', 'c') } },
    ],
  },
  {
    ruling: 'Ties at the deputy or SGA substitute boundaries',
    examples: [
      { name: 'deputy tie: lot, first places do not decide', rulesetId: 'at-representative-v1', candidates: ['a', 'b', 'c'], ballots: DEPUTY_TIE, expected: { kind: 'lot-required', lots: [{ id: 'positions:deputy', candidates: ['b', 'c'] }] } },
      { name: 'the recorded lot fills the position', rulesetId: 'at-representative-v1', candidates: ['a', 'b', 'c'], ballots: DEPUTY_TIE, lots: [{ lotId: 'positions:deputy', order: ['c', 'b'] }], expected: { kind: 'final', positions: representative('a', 'c') } },
      // d and g have 18 points each.
      { name: 'SGA tie', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], ballots: [[4, ['a', 'b', 'c', 'd', 'e', 'f']], [3, ['g', 'b', 'c', 'e', 'd', 'f']]], expected: { kind: 'lot-required', lots: [{ id: 'positions:sga-deputy-1', candidates: ['d', 'g'] }] } },
    ],
  },
  {
    ruling: 'Class and department representatives use the same rule as the Schulsprecher',
    examples: [
      { name: 'more than half of the first places', rulesetId: 'at-representative-v1', candidates: ['a', 'b', 'c'], ballots: [[3, ['a', 'b']], [2, ['b', 'c']]], expected: { kind: 'final', positions: representative('a', 'b') } },
      // b and c 1 first place each; b 4 points, c 3.
      { name: 'runoff entry by first places, then points', rulesetId: 'at-representative-v1', candidates: ['a', 'b', 'c', 'd'], ballots: [[2, ['a', 'b']], [1, ['b', 'c']], [1, ['c', 'd']]], expected: { kind: 'runoff-required', runoffCandidates: ['a', 'b'] } },
    ],
  },
  {
    ruling: 'Zero valid ballots in a contest',
    examples: [
      { name: 'no ballots', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c'], ballots: [], expected: { kind: 'committee-decision', reason: 'no-valid-ballots' } },
      { name: 'only invalid votes', rulesetId: 'at-representative-v1', candidates: ['a', 'b'], ballots: [[4, 'invalid']], expected: { kind: 'committee-decision', reason: 'no-valid-ballots' } },
      { name: 'only invalid votes in the runoff', rulesetId: 'at-school-speaker-v1', candidates: EIGHT, ballots: TIE_FOR_SECOND, runoff: [[2, 'invalid']], expected: { kind: 'committee-decision', reason: 'no-valid-ballots' } },
    ],
  },
  {
    ruling: 'A contest with a single candidate',
    examples: [
      { name: '"Ja" on more than half of "Ja" plus "Nein": elected', rulesetId: 'at-school-speaker-v1', candidates: ['a'], ballots: [[6, ['a']], [5, 'no'], [4, 'invalid']], expected: { kind: 'final', positions: speaker(['a']) } },
      { name: '"Ja" on exactly half: the school committee decides', rulesetId: 'at-school-speaker-v1', candidates: ['a'], ballots: [[5, ['a']], [5, 'no']], expected: { kind: 'committee-decision', reason: 'single-candidate-not-elected' } },
      { name: 'class representative rejected by "Nein"', rulesetId: 'at-representative-v1', candidates: ['a'], ballots: [[2, ['a']], [3, 'no']], expected: { kind: 'committee-decision', reason: 'single-candidate-not-elected' } },
    ],
  },
  {
    ruling: 'Fewer candidates than positions',
    examples: [
      { name: 'three Schulsprecher candidates: the SGA substitutes stay vacant', rulesetId: 'at-school-speaker-v1', candidates: ['a', 'b', 'c'], ballots: [[2, ['a', 'b', 'c']], [1, ['b', 'c', 'a']]], expected: { kind: 'final', positions: speaker(['a', 'b', 'c']) } },
      { name: 'a single class representative: the deputy stays vacant', rulesetId: 'at-representative-v1', candidates: ['a'], ballots: [[2, ['a']], [1, 'no']], expected: { kind: 'final', positions: representative('a', null) } },
    ],
  },
]
