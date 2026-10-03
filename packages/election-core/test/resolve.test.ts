import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  firstRoundResult,
  resolve,
  runoffResult,
  type FirstRoundResult,
  type LotDecision,
  type Outcome,
  type RunoffResult,
} from '../src/index.ts'
import { contest, profile } from './helpers/ballots.ts'

function outcome(first: FirstRoundResult, runoff: RunoffResult | undefined, decisions: readonly LotDecision[] = []): Outcome {
  const resolution = resolve(first, runoff, decisions)
  assert.ok(resolution.ok, `refused: ${resolution.ok ? '' : JSON.stringify(resolution.error)}`)
  return resolution.outcome
}

const holders = (o: Outcome) => 'positions' in o ? Object.fromEntries(o.positions.map((p) => [p.function, p.candidateId ?? p.basis])) : {}

function runoff(candidates: readonly [string, string], votes: readonly [number, number]): RunoffResult {
  const c = contest(candidates, 'single-choice-v1', 'runoff')
  return runoffResult(c, profile(c, [[votes[0], [candidates[0]]], [votes[1], [candidates[1]]]]))
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

// Alice leads on first places; Bob enters the runoff over Carol on points.
// d has no first place but by far the most points.
const eight = contest(['alice', 'bob', 'carol', 'd', 'e', 'f', 'g', 'h'])
const tieForSecond = firstRoundResult(eight, profile(eight, [
  [19, ['alice', 'bob', 'd', 'e', 'f', 'g']],
  [15, ['alice', 'carol', 'd', 'e', 'f', 'g']],
  [1, ['alice', 'd', 'carol', 'e', 'f', 'g']],
  [6, ['alice', 'd', 'e', 'f', 'g', 'h']],
  [32, ['bob', 'd', 'e', 'f', 'g', 'h']],
  [32, ['carol', 'd', 'e', 'f', 'g', 'h']],
]))

test('after the runoff, every other position comes from first-round points: the runoff loser is no automatic deputy', () => {
  const points = Object.fromEntries(tieForSecond.statistics.candidates.map((s) => [s.candidateId, s.points]))
  assert.deepEqual(points, { alice: 246, bob: 287, carol: 271, d: 491, e: 385, f: 280, g: 175, h: 70 })
  assert.deepEqual(outcome(tieForSecond, undefined), { kind: 'runoff-required', runoffCandidates: ['alice', 'bob'], trace: tieForSecond.trace })

  const bobWins = outcome(tieForSecond, runoff(['alice', 'bob'], [40, 60]))
  assert.equal(bobWins.kind, 'final')
  assert.deepEqual(holders(bobWins), {
    'school-speaker': 'bob',
    'school-speaker-deputy-1': 'd',
    'school-speaker-deputy-2': 'e',
    'sga-deputy-1': 'f',
    'sga-deputy-2': 'carol',
    'sga-deputy-3': 'alice',
  })
  assert.deepEqual(bobWins.kind === 'final' && bobWins.positions[0], { function: 'school-speaker', candidateId: 'bob', basis: 'runoff' })
  assert.deepEqual(bobWins.trace.slice(tieForSecond.trace.length).map((s) => s.step), ['count', 'compare', 'positions'])

  const aliceWins = outcome(tieForSecond, runoff(['bob', 'alice'], [1, 2]))
  assert.deepEqual(holders(aliceWins), {
    'school-speaker': 'alice',
    'school-speaker-deputy-1': 'd',
    'school-speaker-deputy-2': 'e',
    'sga-deputy-1': 'bob',
    'sga-deputy-2': 'f',
    'sga-deputy-3': 'carol',
  })
})

test('the runoff neither replaces nor recalculates the first-round figures, and nothing is mutated', () => {
  const first = deepFreeze(structuredClone(tieForSecond))
  const second = deepFreeze(runoff(['alice', 'bob'], [10, 11]))
  const before = structuredClone({ first, second })
  const resolved = outcome(first, second)
  assert.deepEqual({ first, second }, before)
  assert.deepEqual(outcome(first, second), resolved)
})

test('a runoff tie is a manual case: no winner, no lot, no positions', () => {
  const tie = outcome(tieForSecond, runoff(['alice', 'bob'], [50, 50]))
  assert.deepEqual([tie.kind, tie.kind === 'tie' && tie.candidates], ['tie', ['alice', 'bob']])
  assert.ok(!('positions' in tie) && !('lots' in tie))
  assert.equal(outcome(tieForSecond, runoff(['alice', 'bob'], [0, 0])).kind, 'committee-decision')
})

// a leads on first places; b and c are equal on first places and points, so
// a lot decides which of them enters the runoff.
const abc = contest(['a', 'b', 'c'])
const entryLot = firstRoundResult(abc, profile(abc, [[1, ['a', 'b', 'c']], [1, ['a', 'c', 'b']], [1, ['b', 'a', 'c']], [1, ['c', 'a', 'b']]]))

test('a recorded runoff-entry lot sends the first drawn into the runoff', () => {
  assert.ok(entryLot.kind === 'lot-required')
  assert.deepEqual(outcome(entryLot, undefined), { kind: 'lot-required', lots: [entryLot.lot], positions: [], trace: entryLot.trace })
  const drawn = outcome(entryLot, undefined, [{ lotId: 'runoff-entry', order: ['c', 'b'] }])
  assert.deepEqual(drawn, {
    kind: 'runoff-required',
    runoffCandidates: ['a', 'c'],
    trace: [...entryLot.trace, { step: 'lot-applied', lotId: 'runoff-entry', order: ['c', 'b'] }, { step: 'runoff', candidates: ['a', 'c'] }],
  })
})

test('the same candidates tied twice are two lots: the runoff-entry draw does not decide the deputies', () => {
  const entry = { lotId: 'runoff-entry', order: ['c', 'b'] }
  const second = runoff(['a', 'c'], [3, 1])
  const pending = outcome(entryLot, second, [entry])
  assert.deepEqual(pending.kind === 'lot-required' && pending.lots, [
    { id: 'positions:school-speaker-deputy-1', reason: 'positions', candidates: ['b', 'c'], positions: ['school-speaker-deputy-1', 'school-speaker-deputy-2'] },
  ])
  const final = outcome(entryLot, second, [entry, { lotId: 'positions:school-speaker-deputy-1', order: ['b', 'c'] }])
  assert.deepEqual(holders(final), {
    'school-speaker': 'a',
    'school-speaker-deputy-1': 'b',
    'school-speaker-deputy-2': 'c',
    'sga-deputy-1': 'vacant',
    'sga-deputy-2': 'vacant',
    'sga-deputy-3': 'vacant',
  })
  assert.deepEqual(final.trace.slice(-3).map((s) => s.step), ['positions', 'lot-required', 'lot-applied'])
})

// Representative contest won in round 1 with a tie for deputy.
const rep = contest(['a', 'b', 'c'], 'at-representative-v1')
const deputyLot = firstRoundResult(rep, profile(rep, [[4, ['a', 'c']], [2, ['b', 'a']]]))

test('a recorded positions lot fills the tied position; the first round already showed the lot', () => {
  assert.equal(outcome(deputyLot, undefined).kind, 'lot-required')
  const final = outcome(deputyLot, undefined, [{ lotId: 'positions:deputy', order: ['c', 'b'] }])
  assert.deepEqual(final.kind === 'final' && final.positions, [
    { function: 'representative', candidateId: 'a', basis: 'majority' },
    { function: 'deputy', candidateId: 'c', basis: 'lot' },
  ])
  assert.deepEqual(final.trace, [...deputyLot.trace, { step: 'lot-applied', lotId: 'positions:deputy', order: ['c', 'b'] }])
})

test('a decision must order exactly the tied set, once per lot, for a lot that is required', () => {
  const refused = (decisions: LotDecision[], first: FirstRoundResult = deputyLot) => {
    const resolution = resolve(first, undefined, decisions)
    return resolution.ok ? undefined : resolution.error
  }
  for (const order of [['a', 'b'], ['b'], ['b', 'c', 'a'], ['b', 'b'], ['b', 'c', 'c'], []]) {
    assert.deepEqual(refused([{ lotId: 'positions:deputy', order }]), { kind: 'not-the-tied-set', lotId: 'positions:deputy' }, JSON.stringify(order))
  }
  assert.deepEqual(refused([{ lotId: 'positions:deputy', order: ['b', 'c'] }, { lotId: 'positions:deputy', order: ['b', 'c'] }]), { kind: 'duplicate-lot', lotId: 'positions:deputy' })
  assert.deepEqual(refused([{ lotId: 'runoff-entry', order: ['b', 'c'] }]), { kind: 'unknown-lot', lotId: 'runoff-entry' })
  // A deputy lot cannot be recorded before the runoff has decided who is left.
  assert.deepEqual(refused([{ lotId: 'positions:school-speaker-deputy-1', order: ['b', 'c'] }], entryLot), { kind: 'unknown-lot', lotId: 'positions:school-speaker-deputy-1' })
  assert.deepEqual(refused([{ lotId: 'runoff-entry', order: ['a', 'b'] }], entryLot), { kind: 'not-the-tied-set', lotId: 'runoff-entry' })
})

test('applying the same decisions again, or in another order, gives the same outcome', () => {
  const decisions = [{ lotId: 'positions:school-speaker-deputy-1', order: ['b', 'c'] }, { lotId: 'runoff-entry', order: ['c', 'b'] }]
  const second = runoff(['a', 'c'], [3, 1])
  const once = outcome(entryLot, second, decisions)
  assert.deepEqual(outcome(entryLot, second, decisions), once)
  assert.deepEqual(outcome(entryLot, second, decisions.toReversed()), once)
})

test('a runoff that does not belong to the first round is a programming error', () => {
  assert.throws(() => resolve(deputyLot, runoff(['a', 'b'], [1, 0]), []), TypeError)
  assert.throws(() => resolve(tieForSecond, runoff(['alice', 'carol'], [1, 0]), []), TypeError)
  assert.throws(() => resolve(entryLot, runoff(['a', 'b'], [1, 0]), []), TypeError)
  const empty = firstRoundResult(abc, [])
  assert.throws(() => resolve(empty, runoff(['a', 'b'], [1, 0]), []), TypeError)
  assert.deepEqual(outcome(empty, undefined), { kind: 'committee-decision', reason: 'no-valid-ballots', trace: empty.trace })
})
