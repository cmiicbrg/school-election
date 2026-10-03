import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstRoundResult, RULESETS, type ContestStatistics, type FirstRoundResult, type RulesetId } from '../src/index.ts'
import { derivePositions } from '../src/positions.ts'
import { contest, profile } from './helpers/ballots.ts'

const SPEAKER = 'at-school-speaker-v1'
const REPRESENTATIVE = 'at-representative-v1'

function elected(result: FirstRoundResult) {
  assert.ok(result.kind === 'elected', `expected elected, got ${result.kind}`)
  return result
}

const holders = (result: { positions: readonly { function: string, candidateId: string | null, basis: string }[] }) =>
  Object.fromEntries(result.positions.map((p) => [p.function, p.candidateId ?? p.basis]))

test('Schulsprecher: deputies and SGA substitutes by first-round points, the winner left out', () => {
  // a wins on first places with fewer points than b and c; the positions
  // follow the points of everyone else, and d and g tie for two of them.
  const c = contest(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  const result = elected(firstRoundResult(c, profile(c, [
    [4, ['a', 'b', 'c', 'd', 'e', 'f']],
    [3, ['g', 'b', 'c', 'e', 'd', 'f']],
  ])))
  const points = Object.fromEntries(result.statistics.candidates.map((s) => [s.candidateId, s.points]))
  assert.deepEqual(points, { a: 24, b: 35, c: 28, d: 18, e: 17, f: 7, g: 18 })
  assert.deepEqual(holders(result), {
    'school-speaker': 'a',
    'school-speaker-deputy-1': 'b',
    'school-speaker-deputy-2': 'c',
    'sga-deputy-1': 'lot-pending',
    'sga-deputy-2': 'lot-pending',
    'sga-deputy-3': 'e',
  })
  assert.deepEqual(result.lots, [{ id: 'positions:sga-deputy-1', reason: 'positions', candidates: ['d', 'g'], positions: ['sga-deputy-1', 'sga-deputy-2'] }])
  assert.deepEqual(result.positions.slice(0, 2), [
    { function: 'school-speaker', candidateId: 'a', basis: 'majority' },
    { function: 'school-speaker-deputy-1', candidateId: 'b', basis: 'points' },
  ])
  assert.deepEqual(result.trace.at(-2), {
    step: 'positions',
    excluded: 'a',
    values: [['b', 35], ['c', 28], ['d', 18], ['g', 18], ['e', 17], ['f', 7]].map(([candidateId, value]) => ({ candidateId, value })),
  })
})

test('class or department representative: one deputy, the highest remaining total, not the most first places', () => {
  const c = contest(['a', 'b', 'c'], REPRESENTATIVE)
  const result = elected(firstRoundResult(c, profile(c, [[4, ['a', 'c']], [2, ['b', 'a']], [1, ['c', 'b']]])))
  const stats = Object.fromEntries(result.statistics.candidates.map((s) => [s.candidateId, [s.firstPlaces, s.points]]))
  assert.deepEqual([stats.b, stats.c], [[2, 5], [1, 6]])
  assert.deepEqual(holders(result), { representative: 'a', deputy: 'c' })
})

test('a tie on points at a position is a lot, decided directly: first places are no secondary discriminator', () => {
  const c = contest(['a', 'b', 'c'], REPRESENTATIVE)
  const result = elected(firstRoundResult(c, profile(c, [[4, ['a', 'c']], [2, ['b', 'a']]])))
  const stats = Object.fromEntries(result.statistics.candidates.map((s) => [s.candidateId, [s.firstPlaces, s.points]]))
  assert.deepEqual([stats.b, stats.c], [[2, 4], [0, 4]])
  assert.deepEqual(holders(result), { representative: 'a', deputy: 'lot-pending' })
  assert.deepEqual(result.lots, [{ id: 'positions:deputy', reason: 'positions', candidates: ['b', 'c'], positions: ['deputy'] }])
})

test('vacancies: positions beyond the remaining candidates stay vacant', () => {
  const three = contest(['a', 'b', 'c'])
  assert.deepEqual(holders(elected(firstRoundResult(three, profile(three, [[2, ['a', 'b', 'c']], [1, ['b', 'c', 'a']]])))), {
    'school-speaker': 'a',
    'school-speaker-deputy-1': 'b',
    'school-speaker-deputy-2': 'c',
    'sga-deputy-1': 'vacant',
    'sga-deputy-2': 'vacant',
    'sga-deputy-3': 'vacant',
  })
  const one = contest(['a'], REPRESENTATIVE)
  assert.deepEqual(holders(elected(firstRoundResult(one, profile(one, [[2, ['a']], [1, 'no']])))), { representative: 'a', deputy: 'vacant' })
})

test('a tie below the last position needs no lot; one across it decides only the last position', () => {
  const stats = statistics({ a: 30, b: 20, c: 19, d: 18, e: 17, f: 16, g: 5, h: 5 })
  assert.deepEqual(derivePositions(stats, SPEAKER, { candidateId: 'a', basis: 'majority' }, () => undefined).lots, [])
  const across = derivePositions(statistics({ a: 30, b: 20, c: 19, d: 18, e: 17, f: 5, g: 5, h: 5 }), SPEAKER, { candidateId: 'a', basis: 'runoff' }, () => undefined)
  assert.deepEqual(across.lots, [{ id: 'positions:sga-deputy-3', reason: 'positions', candidates: ['f', 'g', 'h'], positions: ['sga-deputy-3'] }])
  assert.deepEqual(across.positions[0], { function: 'school-speaker', candidateId: 'a', basis: 'runoff' })
})

test('recorded lot orders fill the tied positions in the order drawn', () => {
  const stats = statistics({ a: 30, b: 20, c: 20, d: 20, e: 10 })
  const derived = derivePositions(stats, SPEAKER, { candidateId: 'a', basis: 'majority' }, (lot) => lot.id === 'positions:school-speaker-deputy-1' ? ['d', 'b', 'c'] : undefined)
  assert.deepEqual(derived.positions.map((p) => [p.candidateId, p.basis]), [['a', 'majority'], ['d', 'lot'], ['b', 'lot'], ['c', 'lot'], ['e', 'points'], [null, 'vacant']])
  assert.deepEqual(derived.lots, [])
  assert.deepEqual(derived.applied, [{ step: 'lot-applied', lotId: 'positions:school-speaker-deputy-1', order: ['d', 'b', 'c'] }])
  assert.deepEqual(derived.steps.map((s) => s.step), ['positions', 'lot-required'])
})

// Every point vector over a few candidates against an independent
// formulation: sort the others by points; the candidate at index i holds
// position i unless another remaining candidate has the same points, in which
// case that position waits for the lot of everyone with those points.
function statistics(points: Record<string, number>): ContestStatistics {
  return {
    validBallots: 0,
    noBallots: 0,
    invalidBallots: 0,
    candidates: Object.entries(points).map(([candidateId, value]) => ({ candidateId, firstPlaces: 0, rankCounts: [], points: value })),
  }
}

function reference(stats: ContestStatistics, rulesetId: RulesetId, winner: string) {
  const functions = RULESETS[rulesetId].slots.slice(1).map((s) => s.function)
  const rest = stats.candidates.filter((s) => s.candidateId !== winner).toSorted((x, y) => y.points - x.points)
  const positions = functions.map((fn, i) => {
    const holder = rest[i]
    if (holder === undefined) return [fn, 'vacant']
    return [fn, rest.some((s) => s !== holder && s.points === holder.points) ? 'lot-pending' : holder.candidateId]
  })
  const lots = [...new Set(rest.map((s) => s.points))].flatMap((value) => {
    const start = rest.findIndex((s) => s.points === value)
    const group = rest.filter((s) => s.points === value).map((s) => s.candidateId)
    return group.length > 1 && start < functions.length ? [{ candidates: group.sort(), positions: functions.slice(start, start + group.length) }] : []
  })
  return { positions, lots }
}

test('derived positions match the reference for every point vector of up to seven candidates (exhaustive)', () => {
  for (const rulesetId of [SPEAKER, REPRESENTATIVE] as const) {
    for (let n = 1; n <= 7; n++) {
      const names = Array.from({ length: n }, (_, i) => String.fromCodePoint(97 + i))
      for (let code = 0; code < 3 ** n; code++) {
        const stats = statistics(Object.fromEntries(names.map((name, i) => [name, Math.floor(code / 3 ** i) % 3])))
        for (const winner of names) {
          const derived = derivePositions(stats, rulesetId, { candidateId: winner, basis: 'majority' }, () => undefined)
          const expected = reference(stats, rulesetId, winner)
          assert.deepEqual(derived.positions.slice(1).map((p) => [p.function, p.candidateId ?? p.basis]), expected.positions)
          assert.deepEqual(derived.lots.map((lot) => ({ candidates: [...lot.candidates].sort(), positions: 'positions' in lot ? lot.positions : [] })), expected.lots)
        }
      }
    }
  }
})
