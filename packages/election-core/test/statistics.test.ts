import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeStatistics,
  validateBallot,
  type CandidateId,
  type Contest,
  type ContestStatistics,
  type RulesetId,
  type ValidBallot,
} from '../src/index.ts'
import { permutations, prng, randomInt, shuffle } from './helpers/prng.ts'

function contest(candidates: number, rulesetId: RulesetId = 'at-school-speaker-v1'): Contest {
  return { rulesetId, candidateIds: Array.from({ length: candidates }, (_, i) => `c${i + 1}`) }
}

function ballot(c: Contest, ranking: readonly CandidateId[]): ValidBallot {
  const result = validateBallot(c, ranking)
  if (!result.ok) throw new Error(`test ballot invalid: ${result.error.kind}`)
  return result.ballot
}

function randomBallots(random: () => number, c: Contest, count: number): ValidBallot[] {
  const slots = Math.min(c.candidateIds.length, 6)
  return Array.from({ length: count }, () => ballot(c, shuffle(random, c.candidateIds).slice(0, slots)))
}

const byId = (stats: ContestStatistics) => new Map(stats.candidates.map((s) => [s.candidateId, s]))

test('first places, rank counts and statutory points for a worked example', () => {
  const c = { rulesetId: 'at-school-speaker-v1', candidateIds: ['alice', 'bob', 'carol'] } as const
  const stats = computeStatistics(c, [
    ballot(c, ['alice', 'bob', 'carol']),
    ballot(c, ['alice', 'carol', 'bob']),
    ballot(c, ['bob', 'alice', 'carol']),
  ])
  assert.deepEqual(stats, {
    validBallots: 3,
    candidates: [
      { candidateId: 'alice', firstPlaces: 2, rankCounts: [2, 1, 0], points: 2 * 6 + 1 * 5 },
      { candidateId: 'bob', firstPlaces: 1, rankCounts: [1, 1, 1], points: 6 + 5 + 4 },
      { candidateId: 'carol', firstPlaces: 0, rankCounts: [0, 1, 2], points: 5 + 2 * 4 },
    ],
  })
})

test('with more than six candidates, unranked candidates earn zero', () => {
  const c = contest(8)
  const stats = byId(computeStatistics(c, [ballot(c, ['c8', 'c7', 'c6', 'c5', 'c4', 'c3'])]))
  assert.equal(stats.get('c8')?.points, 6)
  assert.equal(stats.get('c3')?.points, 1)
  assert.deepEqual(stats.get('c1'), { candidateId: 'c1', firstPlaces: 0, rankCounts: [0, 0, 0, 0, 0, 0], points: 0 })
  assert.deepEqual(stats.get('c2')?.points, 0)
})

test('representative contests count 2 and 1 points', () => {
  const c = contest(3, 'at-representative-v1')
  const stats = byId(computeStatistics(c, [ballot(c, ['c1', 'c2']), ballot(c, ['c2', 'c3'])]))
  assert.equal(stats.get('c1')?.points, 2)
  assert.equal(stats.get('c2')?.points, 3)
  assert.equal(stats.get('c3')?.points, 1)
})

test('no ballots: every count is zero', () => {
  const stats = computeStatistics(contest(4), [])
  assert.equal(stats.validBallots, 0)
  assert.ok(stats.candidates.every((s) => s.points === 0 && s.firstPlaces === 0 && s.rankCounts.length === 4))
})

test('statistics do not depend on the order of the ballots', () => {
  const random = prng(0x5eed)
  for (const n of [2, 4, 6, 9]) {
    const c = contest(n)
    const ballots = randomBallots(random, c, 200)
    const expected = computeStatistics(c, ballots)
    for (let round = 0; round < 10; round++) {
      assert.deepEqual(computeStatistics(c, shuffle(random, ballots)), expected)
    }
  }
})

test('a ballot validated for another contest is refused', () => {
  const four = contest(4)
  const three = contest(3)
  assert.throws(() => computeStatistics(three, [ballot(four, ['c1', 'c2', 'c3', 'c4'])]), TypeError)
  const other = { rulesetId: 'at-school-speaker-v1', candidateIds: ['x', 'y', 'z'] } as const
  assert.throws(() => computeStatistics(three, [ballot(other, ['x', 'y', 'z'])]), TypeError)
})

// Fixed versus rescaled points. With n ≤ 6 candidates every valid ballot ranks
// every candidate once, so the statutory scale 6, 5, … (7−n) is the rescaled
// scale n, n−1, … 1 plus the constant 6−n on every ballot. Over V ballots
// each candidate's statutory total is its rescaled total plus V·(6−n): the
// same ordering and the same ties. The rescaled scale exists only in this
// test; production code uses the statutory points alone.

function rescaledTotals(c: Contest, ballots: readonly ValidBallot[]): Map<CandidateId, number> {
  const n = c.candidateIds.length
  const totals = new Map(c.candidateIds.map((id) => [id, 0]))
  for (const b of ballots) b.ranking.forEach((id, slot) => totals.set(id, (totals.get(id) ?? 0) + (n - slot)))
  return totals
}

function assertFixedMatchesRescaled(c: Contest, ballots: readonly ValidBallot[]): void {
  const n = c.candidateIds.length
  const statutory = byId(computeStatistics(c, ballots))
  const rescaled = rescaledTotals(c, ballots)
  for (const id of c.candidateIds) {
    assert.equal(statutory.get(id)?.points, (rescaled.get(id) ?? 0) + ballots.length * (6 - n))
  }
  for (const a of c.candidateIds) {
    for (const b of c.candidateIds) {
      const fixedOrder = Math.sign((statutory.get(a)?.points ?? 0) - (statutory.get(b)?.points ?? 0))
      const rescaledOrder = Math.sign((rescaled.get(a) ?? 0) - (rescaled.get(b) ?? 0))
      assert.equal(fixedOrder, rescaledOrder, `order of ${a} and ${b} differs`)
    }
  }
}

test('fixed and rescaled points agree on every ballot set of up to two ballots, n ≤ 4 (exhaustive)', () => {
  for (let n = 1; n <= 4; n++) {
    const c = contest(n)
    const all = permutations(c.candidateIds).map((ranking) => ballot(c, ranking))
    for (const first of all) {
      assertFixedMatchesRescaled(c, [first])
      for (const second of all) assertFixedMatchesRescaled(c, [first, second])
    }
  }
})

test('fixed and rescaled points agree on every three-ballot set, n ≤ 3 (exhaustive)', () => {
  for (let n = 1; n <= 3; n++) {
    const c = contest(n)
    const all = permutations(c.candidateIds).map((ranking) => ballot(c, ranking))
    for (const a of all) for (const b of all) for (const d of all) assertFixedMatchesRescaled(c, [a, b, d])
  }
})

test('fixed and rescaled points agree on seeded random ballot sets, n ≤ 6', () => {
  const random = prng(20261002)
  for (let n = 1; n <= 6; n++) {
    const c = contest(n)
    for (let round = 0; round < 100; round++) {
      assertFixedMatchesRescaled(c, randomBallots(random, c, 1 + randomInt(random, 300)))
    }
  }
})
