import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  firstRoundResult,
  runoffResult,
  type CastBallot,
  type ContestStatistics,
  type FirstRoundResult,
  type RulesetId,
} from '../src/index.ts'
import { cast, contest, ids, profile } from './helpers/ballots.ts'
import { permutations, prng, randomInt, shuffle } from './helpers/prng.ts'

const SPEAKER = 'at-school-speaker-v1'
const REPRESENTATIVE = 'at-representative-v1'
const SINGLE = 'single-choice-v1'

// The worked example of a runoff selection: Alice leads on first places, Bob
// and Carol tie for the second runoff place on first places, and Bob enters
// on first-round points, 287 > 271. Eight candidates, so the lower slots go
// to the others and the totals can be chosen freely.
const eight = contest(['alice', 'bob', 'carol', 'd', 'e', 'f', 'g', 'h'])
const tieForSecond = profile(eight, [
  [19, ['alice', 'bob', 'd', 'e', 'f', 'g']],
  [15, ['alice', 'carol', 'd', 'e', 'f', 'g']],
  [1, ['alice', 'd', 'carol', 'e', 'f', 'g']],
  [6, ['alice', 'd', 'e', 'f', 'g', 'h']],
  [32, ['bob', 'd', 'e', 'f', 'g', 'h']],
  [32, ['carol', 'd', 'e', 'f', 'g', 'h']],
])

test('a tie for the second runoff place on first places is decided by first-round points, with the full trace', () => {
  const result = firstRoundResult(eight, tieForSecond)
  assert.equal(result.kind, 'runoff-required')
  assert.deepEqual(result.runoffCandidates, ['alice', 'bob'])
  const zero = (id: string) => ({ candidateId: id, value: 0 })
  assert.deepEqual(result.trace, [
    { step: 'count', contestId: 'contest', ballotsCast: 105, validBallots: 105, noBallots: 0, invalidBallots: 0 },
    { step: 'majority', required: 53, elected: null },
    {
      step: 'compare',
      basis: 'first-places',
      seats: 2,
      values: [{ candidateId: 'alice', value: 41 }, { candidateId: 'bob', value: 32 }, { candidateId: 'carol', value: 32 }, ...['d', 'e', 'f', 'g', 'h'].map(zero)],
      advancing: ['alice'],
      tied: ['bob', 'carol'],
    },
    { step: 'compare', basis: 'points', seats: 1, values: [{ candidateId: 'bob', value: 287 }, { candidateId: 'carol', value: 271 }], advancing: ['bob'], tied: [] },
    { step: 'runoff', candidates: ['alice', 'bob'] },
  ])
})

test('majority boundary: 50 of 100 is no majority, 51 of 100 and 50 of 99 are', () => {
  const c = contest(['a', 'b', 'c'])
  const split = (first: number, valid: number) => profile(c, [[first, ['a', 'b', 'c']], [valid - first, ['b', 'c', 'a']]])
  assert.equal(firstRoundResult(c, split(50, 100)).kind, 'runoff-required')
  assert.deepEqual(winner(firstRoundResult(c, split(51, 100))), 'a')
  assert.deepEqual(winner(firstRoundResult(c, split(50, 99))), 'a')
})

test('majority boundary, exhaustive: elected exactly with more than half of the valid ballots as first places', () => {
  for (const rulesetId of [SPEAKER, REPRESENTATIVE] as const) {
    const c = contest(['a', 'b', 'c'], rulesetId)
    const slots = rulesetId === SPEAKER ? 3 : 2
    for (let valid = 1; valid <= 40; valid++) {
      for (let first = 0; first <= valid; first++) {
        for (const invalid of [0, 1, valid]) {
          const ballots = profile(c, [
            [first, ['a', 'c', 'b'].slice(0, slots)],
            [valid - first, ['b', 'c', 'a'].slice(0, slots)],
            [invalid, 'invalid'],
          ])
          const result = firstRoundResult(c, ballots)
          const expected = 2 * first > valid ? 'a' : 2 * (valid - first) > valid ? 'b' : undefined
          assert.equal(winner(result), expected, `${rulesetId} ${first}/${valid}, ${invalid} invalid`)
          assert.deepEqual(result.trace[1], { step: 'majority', required: Math.floor(valid / 2) + 1, elected: expected ?? null })
        }
      }
    }
  }
})

test('the majority is counted from first places, never inferred from points', () => {
  // c has more points than a, but a is first on 3 of 5 ballots.
  const c = contest(['a', 'b', 'c', 'd'])
  const ballots = profile(c, [[3, ['a', 'c', 'd', 'b']], [2, ['b', 'c', 'd', 'a']]])
  const points = new Map(firstRoundResult(c, ballots).statistics.candidates.map((s) => [s.candidateId, s.points]))
  assert.ok((points.get('a') ?? 0) < (points.get('c') ?? 0))
  assert.equal(winner(firstRoundResult(c, ballots)), 'a')
})

test('the majority base is the valid ballots: invalid votes do not count, "Nein" does', () => {
  const c = contest(['a', 'b', 'c'])
  // 5 of 9 valid ballots, with 6 invalid votes on top: still elected.
  const withInvalid = firstRoundResult(c, profile(c, [[5, ['a', 'b', 'c']], [4, ['b', 'a', 'c']], [6, 'invalid']]))
  assert.equal(winner(withInvalid), 'a')
  assert.deepEqual(withInvalid.trace.slice(0, 2), [
    { step: 'count', contestId: 'contest', ballotsCast: 15, validBallots: 9, noBallots: 0, invalidBallots: 6 },
    { step: 'majority', required: 5, elected: 'a' },
  ])
  const single = contest(['a'])
  assert.equal(firstRoundResult(single, profile(single, [[5, ['a']], [5, 'no'], [3, 'invalid']])).kind, 'committee-decision')
})

test('a 50/50 split goes to the runoff on first places alone, without comparing points', () => {
  const c = contest(['a', 'b'])
  const result = firstRoundResult(c, profile(c, [[3, ['a', 'b']], [3, ['b', 'a']]]))
  assert.equal(result.kind, 'runoff-required')
  assert.deepEqual(result.trace.filter((s) => s.step === 'compare').map((s) => s.basis), ['first-places'])
  const three = contest(['a', 'b', 'c'])
  const unequalPoints = firstRoundResult(three, profile(three, [[3, ['a', 'b', 'c']], [3, ['b', 'c', 'a']]]))
  assert.ok(unequalPoints.kind === 'runoff-required')
  assert.deepEqual(unequalPoints.runoffCandidates, ['a', 'b'])
})

test('a clear top two on first places enter the runoff', () => {
  const c = contest(['a', 'b', 'c', 'd'])
  const result = firstRoundResult(c, profile(c, [[4, ['a', 'd', 'c', 'b']], [3, ['b', 'd', 'c', 'a']], [2, ['c', 'd', 'b', 'a']], [1, ['d', 'c', 'b', 'a']]]))
  assert.ok(result.kind === 'runoff-required')
  assert.deepEqual(result.runoffCandidates, ['a', 'b'])
})

test('more first places always beat more points: only the tied candidates are compared on points', () => {
  // b has 2 first places and few points; c and d have 1 each and many points.
  const c = contest(['a', 'b', 'c', 'd', 'e'])
  const result = firstRoundResult(c, profile(c, [
    [3, ['a', 'c', 'd', 'e', 'b']],
    [2, ['b', 'c', 'd', 'e', 'a']],
    [1, ['c', 'd', 'e', 'a', 'b']],
    [1, ['d', 'c', 'e', 'a', 'b']],
  ]))
  const points = new Map(result.statistics.candidates.map((s) => [s.candidateId, s.points]))
  assert.ok((points.get('c') ?? 0) > (points.get('b') ?? 0))
  assert.ok(result.kind === 'runoff-required')
  assert.deepEqual(result.runoffCandidates, ['a', 'b'])
})

test('an unresolved tie for runoff entry is lot-required with the tied set', () => {
  const c = contest(['a', 'b', 'c'])
  // a leads; b and c are equal on first places and on points.
  const result = firstRoundResult(c, profile(c, [[1, ['a', 'b', 'c']], [1, ['a', 'c', 'b']], [1, ['b', 'a', 'c']], [1, ['c', 'a', 'b']]]))
  assert.ok(result.kind === 'lot-required')
  assert.deepEqual(result.lot, { id: 'runoff-entry', reason: 'runoff-entry', candidates: ['b', 'c'], seats: 1, qualified: ['a'] })
  assert.deepEqual(result.trace.slice(2).map((s) => s.step === 'compare' ? [s.basis, s.advancing, s.tied] : s.step), [
    ['first-places', ['a'], ['b', 'c']],
    ['points', [], ['b', 'c']],
    'lot-required',
  ])
})

test('a three-way first-place tie: points decide, and a tie on points too goes to the lot for both places', () => {
  const c = contest(['a', 'b', 'c'])
  const byPoints = firstRoundResult(c, profile(c, [[1, ['a', 'b', 'c']], [1, ['b', 'a', 'c']], [1, ['c', 'a', 'b']]]))
  assert.ok(byPoints.kind === 'runoff-required')
  assert.deepEqual(byPoints.runoffCandidates, ['a', 'b'])
  const cyclic = firstRoundResult(c, profile(c, [[1, ['a', 'b', 'c']], [1, ['b', 'c', 'a']], [1, ['c', 'a', 'b']]]))
  assert.ok(cyclic.kind === 'lot-required')
  assert.deepEqual(cyclic.lot, { id: 'runoff-entry', reason: 'runoff-entry', candidates: ['a', 'b', 'c'], seats: 2, qualified: [] })
  // a leads on points, b and c tie behind: a enters, the lot picks one of b, c.
  const oneSeat = firstRoundResult(c, profile(c, [[1, ['a', 'b', 'c']], [1, ['a', 'c', 'b']], [2, ['b', 'a', 'c']], [2, ['c', 'a', 'b']]]))
  assert.ok(oneSeat.kind === 'lot-required')
  assert.deepEqual([oneSeat.lot.qualified, oneSeat.lot.candidates, oneSeat.lot.seats], [['a'], ['b', 'c'], 1])
})

test('zero valid ballots: the school committee decides, with no winner, lot or positions', () => {
  for (const rulesetId of [SPEAKER, REPRESENTATIVE] as const) {
    for (const n of [1, 2, 7]) {
      const c = contest(ids(n), rulesetId)
      for (const ballots of [[], profile(c, [[3, 'invalid']])]) {
        const result = firstRoundResult(c, ballots)
        assert.deepEqual([result.kind, result.kind === 'committee-decision' && result.reason], ['committee-decision', 'no-valid-ballots'])
        assert.deepEqual(result.trace.map((s) => s.step), ['count', 'committee-decision'])
      }
    }
  }
})

test('single candidate, exhaustive: elected with "Ja" on more than half of "Ja" plus "Nein", otherwise the committee decides', () => {
  for (const rulesetId of [SPEAKER, REPRESENTATIVE] as const) {
    const c = contest(['a'], rulesetId)
    for (let yes = 0; yes <= 12; yes++) {
      for (let no = 0; no <= 12; no++) {
        for (const invalid of [0, 1, 7]) {
          const result = firstRoundResult(c, profile(c, [[yes, ['a']], [no, 'no'], [invalid, 'invalid']]))
          const reason = yes + no === 0 ? 'no-valid-ballots' : 'single-candidate-not-elected'
          if (2 * yes > yes + no) assert.equal(winner(result), 'a')
          else assert.deepEqual([result.kind, result.kind === 'committee-decision' && result.reason], ['committee-decision', reason])
        }
      }
    }
  }
})

// Runoff selection against an independent formulation: rank by first places,
// then by points; the top two enter unless the second and third are equal on
// both, in which case everyone equal to the second goes to the lot.
function referenceSelection(stats: ContestStatistics): { pair: string[] } | { tied: string[], qualified: string[] } {
  const compare = (x: { firstPlaces: number, points: number }, y: { firstPlaces: number, points: number }) => y.firstPlaces - x.firstPlaces || y.points - x.points
  const ranked = stats.candidates.toSorted(compare)
  const [first, second, third] = ranked
  if (first === undefined || second === undefined) throw new Error('needs two candidates')
  if (third === undefined || compare(second, third) !== 0) return { pair: [first.candidateId, second.candidateId].sort() }
  return {
    tied: ranked.filter((s) => compare(s, second) === 0).map((s) => s.candidateId).sort(),
    qualified: ranked.filter((s) => compare(s, second) < 0).map((s) => s.candidateId).sort(),
  }
}

function assertSelection(result: FirstRoundResult, label: string): void {
  const { statistics } = result
  const majority = statistics.candidates.find((s) => 2 * s.firstPlaces > statistics.validBallots)
  if (majority !== undefined) {
    assert.equal(winner(result), majority.candidateId, label)
    return
  }
  const expected = referenceSelection(statistics)
  if ('pair' in expected) {
    assert.ok(result.kind === 'runoff-required', label)
    assert.deepEqual([...result.runoffCandidates].sort(), expected.pair, label)
  } else {
    assert.ok(result.kind === 'lot-required', label)
    assert.deepEqual([...result.lot.candidates].sort(), expected.tied, label)
    assert.deepEqual([...result.lot.qualified].sort(), expected.qualified, label)
    assert.equal(result.lot.seats, 2 - expected.qualified.length, label)
  }
}

function allRankings(candidates: readonly string[], slots: number): string[][] {
  const unique = new Map(permutations(candidates).map((p) => [p.slice(0, slots).join(), p.slice(0, slots)]))
  return [...unique.values()]
}

test('runoff selection matches the reference on every ballot set of up to three ballots (exhaustive)', () => {
  for (const [n, rulesetId] of [[2, SPEAKER], [3, SPEAKER], [4, SPEAKER], [3, REPRESENTATIVE], [4, REPRESENTATIVE]] as const) {
    const c = contest(ids(n), rulesetId)
    const rankings = allRankings(c.candidateIds, rulesetId === SPEAKER ? n : 2).map((r) => cast(c, r))
    for (const a of rankings) {
      assertSelection(firstRoundResult(c, [a]), `${rulesetId} ${n}`)
      for (const b of rankings) {
        assertSelection(firstRoundResult(c, [a, b]), `${rulesetId} ${n}`)
        for (const d of rankings) assertSelection(firstRoundResult(c, [a, b, d]), `${rulesetId} ${n}`)
      }
    }
  }
})

function randomBallots(random: () => number, rulesetId: RulesetId, n: number, count: number) {
  const c = contest(ids(n), rulesetId)
  const slots = rulesetId === SPEAKER ? Math.min(n, 6) : 2
  // A skewed candidate pool makes first-place ties and near-majorities common.
  const ballots = Array.from({ length: count }, () => {
    const pool = shuffle(random, c.candidateIds)
    return cast(c, randomInt(random, 4) === 0 ? 'invalid' : pool.slice(0, slots))
  })
  return { c, ballots }
}

test('runoff selection matches the reference on seeded random ballot sets', () => {
  const random = prng(0x2026_1003)
  for (let round = 0; round < 3000; round++) {
    const rulesetId = randomInt(random, 2) === 0 ? SPEAKER : REPRESENTATIVE
    const { c, ballots } = randomBallots(random, rulesetId, 2 + randomInt(random, 8), 1 + randomInt(random, 12))
    if (ballots.every((b) => b.kind === 'invalid')) continue
    assertSelection(firstRoundResult(c, ballots), `round ${round}`)
  }
})

test('the result and its trace do not depend on the order of the ballots', () => {
  const random = prng(0x0bd3)
  for (let round = 0; round < 200; round++) {
    const { c, ballots } = randomBallots(random, randomInt(random, 2) === 0 ? SPEAKER : REPRESENTATIVE, 2 + randomInt(random, 8), 1 + randomInt(random, 30))
    const expected = firstRoundResult(c, ballots)
    for (let i = 0; i < 5; i++) assert.deepEqual(firstRoundResult(c, shuffle(random, ballots)), expected)
  }
  assert.deepEqual(firstRoundResult(eight, shuffle(random, tieForSecond)), firstRoundResult(eight, tieForSecond))
})

// Renaming every candidate and reordering the candidate list must not change
// who is elected, who advances or who is tied: no decision may fall back to an
// id or a list position. Results are compared with the names mapped back and
// every set of candidates sorted, since list order inside a tie is only how
// it is shown.
function canonical(value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return names.get(value) ?? value
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item, names))
    const isSet = items.every((item) => typeof item === 'string' || (typeof item === 'object' && item !== null && 'candidateId' in item))
    return isSet ? items.toSorted((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) : items
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonical(item, names)]))
  }
  return value
}

function renamed(random: () => number, c: ReturnType<typeof contest>, ballots: readonly CastBallot[]) {
  const alias = new Map(c.candidateIds.map((id, i) => [id, `z${(c.candidateIds.length - i) * 7}`]))
  const back = new Map([...alias].map(([id, name]) => [name, id]))
  const other = contest(shuffle(random, c.candidateIds.map((id) => alias.get(id) ?? id)), c.rulesetId, c.id)
  const translated = ballots.map((b) => cast(other, b.kind === 'ranking' ? b.ranking.map((id) => alias.get(id) ?? id) : b.kind))
  return { other, translated, back }
}

test('renaming candidates and permuting their order leave the result and trace the same', () => {
  const random = prng(0xa11a5)
  const cases = [{ c: eight, ballots: tieForSecond }]
  for (let round = 0; round < 300; round++) {
    cases.push(randomBallots(random, randomInt(random, 2) === 0 ? SPEAKER : REPRESENTATIVE, 1 + randomInt(random, 8), 1 + randomInt(random, 10)))
  }
  for (const { c, ballots } of cases) {
    const { other, translated, back } = renamed(random, c, ballots)
    const expected = canonical(firstRoundResult(c, ballots), new Map())
    assert.deepEqual(canonical(firstRoundResult(other, translated), back), expected)
  }
})

test('runoff, exhaustive: more valid votes win, equal votes are a tie with no winner and no lot', () => {
  const c = contest(['a', 'b'], SINGLE, 'runoff')
  for (let a = 0; a <= 15; a++) {
    for (let b = 0; b <= 15; b++) {
      for (const invalid of [0, 2]) {
        const result = runoffResult(c, profile(c, [[a, ['a']], [b, ['b']], [invalid, 'invalid']]))
        if (a + b === 0) assert.deepEqual([result.kind, result.kind === 'committee-decision' && result.reason], ['committee-decision', 'no-valid-ballots'])
        else if (a === b) assert.deepEqual([result.kind, result.kind === 'tie' && result.candidates], ['tie', ['a', 'b']])
        else assert.equal(result.kind === 'elected' && result.winnerId, a > b ? 'a' : 'b')
      }
    }
  }
})

test('runoff trace: the vote count and the comparison', () => {
  const c = contest(['a', 'b'], SINGLE, 'runoff')
  assert.deepEqual(runoffResult(c, profile(c, [[7, ['b']], [5, ['a']], [1, 'invalid']])).trace, [
    { step: 'count', contestId: 'runoff', ballotsCast: 13, validBallots: 12, noBallots: 0, invalidBallots: 1 },
    { step: 'compare', basis: 'votes', seats: 1, values: [{ candidateId: 'b', value: 7 }, { candidateId: 'a', value: 5 }], advancing: ['b'], tied: [] },
  ])
})

test('a single-choice poll: the most votes win, a tie at the top is shown, and one option needs a majority of "Ja"', () => {
  const c = contest(['a', 'b', 'c'], SINGLE, 'poll')
  assert.equal(winner(runoffResult(c, profile(c, [[3, ['a']], [2, ['b']], [2, ['c']]]))), 'a')
  const tie = runoffResult(c, profile(c, [[3, ['a']], [1, ['b']], [3, ['c']]]))
  assert.deepEqual(tie.kind === 'tie' && tie.candidates, ['a', 'c'])
  const one = contest(['a'], SINGLE, 'poll')
  assert.equal(winner(runoffResult(one, profile(one, [[3, ['a']], [2, 'no']]))), 'a')
  assert.equal(runoffResult(one, profile(one, [[2, ['a']], [2, 'no']])).kind, 'committee-decision')
})

test('each counting function refuses the other kind of contest and ballots of another contest', () => {
  assert.throws(() => firstRoundResult(contest(['a', 'b'], SINGLE), []), TypeError)
  assert.throws(() => runoffResult(contest(['a', 'b'], SPEAKER), []), TypeError)
  const other = contest(['a', 'b'], SPEAKER, 'other')
  assert.throws(() => firstRoundResult(contest(['a', 'b']), [cast(other, ['a', 'b'])]), TypeError)
})

function winner(result: { kind: string, winnerId?: string }): string | undefined {
  return result.kind === 'elected' ? result.winnerId : undefined
}
