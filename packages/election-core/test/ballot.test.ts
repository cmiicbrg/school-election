import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contestKey, isBallotFor, offersNo, validateBallot, type BallotError, type Contest, type RulesetId } from '../src/index.ts'
import { permutations } from './helpers/prng.ts'

function contest(candidates: number, rulesetId: RulesetId = 'at-school-speaker-v1', id = 'contest'): Contest {
  return { id, rulesetId, candidateIds: Array.from({ length: candidates }, (_, i) => `c${i + 1}`) }
}

const ranked = (ranking: unknown) => ({ kind: 'ranking', ranking })
const confirmedInvalid = (ranking: unknown) => ({ kind: 'ranking', ranking, confirmInvalid: true })
const NO = { kind: 'no' }

function rejection(c: Contest, input: unknown): BallotError {
  const result = validateBallot(c, input)
  assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be rejected`)
  return (result as { error: BallotError }).error
}

test('a complete ranking is accepted and keeps its order', () => {
  const result = validateBallot(contest(4), ranked(['c3', 'c1', 'c4', 'c2']))
  assert.ok(result.ok)
  assert.equal(result.ballot.kind, 'ranking')
  assert.deepEqual(result.ballot.ranking, ['c3', 'c1', 'c4', 'c2'])
  assert.ok(Object.isFrozen(result.ballot) && Object.isFrozen(result.ballot.ranking))
})

test('the validated ranking is a copy, not the caller\'s array', () => {
  const input = ['c1', 'c2']
  const result = validateBallot(contest(2), ranked(input))
  assert.ok(result.ok)
  input[0] = 'c2'
  assert.deepEqual(result.ballot.ranking, ['c1', 'c2'])
})

test('a duplicate candidate is rejected', () => {
  assert.deepEqual(rejection(contest(3), ranked(['c1', 'c2', 'c1'])), { kind: 'duplicate-candidate', position: 2 })
})

test('an unknown candidate is rejected', () => {
  assert.deepEqual(rejection(contest(3), ranked(['c1', 'c9', 'c2'])), { kind: 'unknown-candidate', position: 1 })
  assert.deepEqual(rejection(contest(2), ranked(['', 'c1'])), { kind: 'unknown-candidate', position: 0 })
})

test('anything but the two ballot forms is malformed, the former blank form included', () => {
  const c = contest(3)
  for (const input of [
    undefined, null, 'c1', 42, [], ['c1', 'c2', 'c3'],
    {}, { kind: 'yes' }, { kind: 'blank' }, { kind: 'Ranking', ranking: ['c1', 'c2', 'c3'] },
    { ranking: ['c1', 'c2', 'c3'] },
  ]) {
    assert.deepEqual(rejection(c, input), { kind: 'malformed', reason: 'unknown-form' }, JSON.stringify(input))
  }
})

test('malformed rankings are rejected', () => {
  const c = contest(3)
  for (const ranking of [undefined, null, 'c1', 42, { 0: 'c1', 1: 'c2', 2: 'c3', length: 3 }, new Set(['c1'])]) {
    assert.deepEqual(rejection(c, ranked(ranking)), { kind: 'malformed', reason: 'not-an-array' })
  }
  for (const ranking of [['c1', 2, 'c3'], [['c1'], 'c2', 'c3'], [{ id: 'c1' }, 'c2', 'c3'], ['c1', undefined, 'c3']]) {
    assert.deepEqual(rejection(c, ranked(ranking)), { kind: 'malformed', reason: 'invalid-entry' })
    assert.deepEqual(rejection(c, confirmedInvalid(ranking)), { kind: 'malformed', reason: 'invalid-entry' })
  }
})

test('a duplicate slot cannot be expressed: slot maps are rejected, not interpreted', () => {
  // The ranking is a list whose position is the slot, so no input can give two
  // candidates the same slot or one candidate two slots without repeating it.
  // Map- or object-shaped rankings that could say "6 → c1, 6 → c2" are not
  // accepted in any form.
  const c = contest(3)
  assert.deepEqual(rejection(c, ranked({ 6: 'c1', 5: 'c2', 4: 'c3' })), { kind: 'malformed', reason: 'not-an-array' })
  assert.deepEqual(rejection(c, ranked(new Map([[6, 'c1'], [5, 'c2']]))), { kind: 'malformed', reason: 'not-an-array' })
  assert.deepEqual(rejection(c, ranked([['c1', 6], ['c2', 6], ['c3', 4]])), { kind: 'malformed', reason: 'invalid-entry' })
})

test('four candidates: assigning only 6 and 5 points is an incomplete ballot', () => {
  assert.deepEqual(rejection(contest(4), ranked(['c1', 'c2'])), { kind: 'incomplete', activeSlots: 4, filled: 2 })
})

test('four candidates: a fifth entry would fill the inactive 2-point slot', () => {
  assert.deepEqual(rejection(contest(4), ranked(['c1', 'c2', 'c3', 'c4', 'c1'])), { kind: 'inactive-slot', activeSlots: 4, entries: 5 })
  assert.deepEqual(rejection(contest(4), ranked(['c1', 'c2', 'c3', 'c4', 'c1', 'c2'])), { kind: 'inactive-slot', activeSlots: 4, entries: 6 })
})

test('more than six candidates: exactly six distinct rankings, the rest stay unranked', () => {
  const c = contest(10)
  assert.ok(validateBallot(c, ranked(['c10', 'c2', 'c7', 'c4', 'c5', 'c1'])).ok)
  assert.deepEqual(rejection(c, ranked(['c1', 'c2', 'c3', 'c4', 'c5'])), { kind: 'incomplete', activeSlots: 6, filled: 5 })
  assert.deepEqual(rejection(c, ranked(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])), { kind: 'inactive-slot', activeSlots: 6, entries: 7 })
})

test('empty slots make an invalid vote, cast only when the voter confirms it', () => {
  const c = contest(4)
  for (const [ranking, filled] of [
    [[], 0],
    [[null, null, null, null], 0],
    [['c1'], 1],
    [['c1', null, 'c3'], 2],
    [['c1', 'c2', null, 'c4'], 3],
    [[null, 'c2', 'c3', 'c4'], 3],
  ] as const) {
    assert.deepEqual(rejection(c, ranked(ranking)), { kind: 'incomplete', activeSlots: 4, filled }, JSON.stringify(ranking))
    const result = validateBallot(c, confirmedInvalid(ranking))
    assert.ok(result.ok, JSON.stringify(ranking))
    assert.equal(result.ballot.kind, 'invalid')
    // An invalid vote counts only as invalid; its partial content is not kept.
    assert.deepEqual(result.ballot.ranking, [])
  }
})

test('"weiß wählen": an all-empty ballot is possible in every contest, whatever the candidate count', () => {
  for (const rulesetId of ['at-school-speaker-v1', 'at-representative-v1', 'single-choice-v1'] as const) {
    for (const n of [1, 2, 4, 6, 10]) {
      const result = validateBallot(contest(n, rulesetId), confirmedInvalid([]))
      assert.ok(result.ok && result.ballot.kind === 'invalid', `${rulesetId} with ${n} candidates`)
    }
  }
})

test('only an explicit confirmInvalid: true casts an invalid vote', () => {
  const c = contest(3)
  for (const confirmInvalid of [false, 'true', 1, null, undefined]) {
    assert.deepEqual(rejection(c, { kind: 'ranking', ranking: ['c1'], confirmInvalid }), { kind: 'incomplete', activeSlots: 3, filled: 1 })
  }
})

test('a validated ballot names the contest it is for: its id, ruleset and candidate set, whatever the candidates\' order', () => {
  const result = validateBallot(contest(3), ranked(['c1', 'c2', 'c3']))
  assert.ok(result.ok)
  const reordered: Contest = { id: 'contest', rulesetId: 'at-school-speaker-v1', candidateIds: ['c3', 'c1', 'c2'] }
  assert.equal(result.ballot.contestKey, contestKey(contest(3)))
  assert.equal(result.ballot.contestKey, contestKey(reordered))
  assert.equal(isBallotFor(result.ballot, contestKey(reordered)), true)
  assert.equal(isBallotFor(result.ballot, contestKey(contest(4))), false)
  assert.equal(isBallotFor(result.ballot, contestKey({ ...contest(3), id: 'other' })), false)
  assert.equal(isBallotFor(result.ballot, contestKey({ ...contest(3), rulesetId: 'at-representative-v1' })), false)
  assert.ok(Object.isFrozen(result.ballot) && Object.isFrozen(result.ballot.ranking))
})

test('a complete ranking stays valid even when confirmInvalid is set', () => {
  const result = validateBallot(contest(2), confirmedInvalid(['c2', 'c1']))
  assert.ok(result.ok)
  assert.equal(result.ballot.kind, 'ranking')
  assert.deepEqual(result.ballot.ranking, ['c2', 'c1'])
})

test('confirming does not let a client cast what no correct client can produce', () => {
  const c = contest(4)
  assert.deepEqual(rejection(c, confirmedInvalid(['c1', 'c1'])), { kind: 'duplicate-candidate', position: 1 })
  assert.deepEqual(rejection(c, confirmedInvalid([null, 'c9'])), { kind: 'unknown-candidate', position: 1 })
  assert.deepEqual(rejection(c, confirmedInvalid(['c1', 'c2', 'c3', 'c4', null])), { kind: 'inactive-slot', activeSlots: 4, entries: 5 })
})

test('"Nein" is offered only in a contest with a single candidate', () => {
  for (const rulesetId of ['at-school-speaker-v1', 'at-representative-v1', 'single-choice-v1'] as const) {
    const single = contest(1, rulesetId)
    assert.ok(offersNo(single))
    const result = validateBallot(single, NO)
    assert.ok(result.ok)
    assert.equal(result.ballot.kind, 'no')
    assert.deepEqual(result.ballot.ranking, [])
    assert.ok(validateBallot(single, ranked(['c1'])).ok, '"Ja" is the one-entry ranking')
    for (const n of [2, 3, 7]) {
      assert.ok(!offersNo(contest(n, rulesetId)))
      assert.deepEqual(rejection(contest(n, rulesetId), NO), { kind: 'no-not-offered' })
    }
  }
})

test('representative contests require one ranking per active slot', () => {
  assert.ok(validateBallot(contest(1, 'at-representative-v1'), ranked(['c1'])).ok)
  assert.ok(validateBallot(contest(5, 'at-representative-v1'), ranked(['c4', 'c2'])).ok)
  assert.deepEqual(rejection(contest(5, 'at-representative-v1'), ranked(['c4'])), { kind: 'incomplete', activeSlots: 2, filled: 1 })
  assert.deepEqual(rejection(contest(5, 'at-representative-v1'), ranked(['c4', 'c2', 'c1'])), { kind: 'inactive-slot', activeSlots: 2, entries: 3 })
})

test('single-choice contests take exactly one candidate', () => {
  const c = contest(2, 'single-choice-v1')
  assert.ok(validateBallot(c, ranked(['c2'])).ok)
  assert.deepEqual(rejection(c, ranked(['c1', 'c2'])), { kind: 'inactive-slot', activeSlots: 1, entries: 2 })
})

// Exhaustive completeness for every candidate count up to six: each
// permutation of all candidates is valid, and each of its proper prefixes,
// the empty one included, is incomplete: refused unless confirmed, and then
// an invalid vote.
for (let n = 1; n <= 6; n++) {
  test(`${n} candidates: all ${permutations(contest(n).candidateIds).length} complete orderings pass, every partial one fails`, () => {
    const c = contest(n)
    for (const ordering of permutations(c.candidateIds)) {
      assert.ok(validateBallot(c, ranked(ordering)).ok)
      for (let length = 0; length < n; length++) {
        const prefix = ordering.slice(0, length)
        const padded = [...prefix, ...Array.from({ length: n - length }, () => null)]
        for (const partial of [prefix, padded]) {
          assert.deepEqual(rejection(c, ranked(partial)), { kind: 'incomplete', activeSlots: n, filled: length })
          const confirmed = validateBallot(c, confirmedInvalid(partial))
          assert.ok(confirmed.ok && confirmed.ballot.kind === 'invalid' && confirmed.ballot.ranking.length === 0)
        }
      }
      // One slot left empty anywhere, including the top one.
      for (let gap = 0; gap < n; gap++) {
        const withGap = ordering.map((id, i) => (i === gap ? null : id))
        assert.deepEqual(rejection(c, ranked(withGap)), { kind: 'incomplete', activeSlots: n, filled: n - 1 })
        assert.ok(validateBallot(c, confirmedInvalid(withGap)).ok)
      }
    }
  })
}

test('errors never contain candidate ids', () => {
  const c = contest(3)
  for (const ranking of [['c1', 'c1', 'c2'], ['c1', 'secret-id', 'c2'], ['c1'], ['c1', 'c2', 'c3', 'c1']]) {
    const error = JSON.stringify(rejection(c, ranked(ranking)))
    assert.doesNotMatch(error, /c\d|secret-id/)
  }
})

test('an invalid contest is a programming error, not a ballot error', () => {
  const c1 = ranked(['c1'])
  assert.throws(() => validateBallot({ id: 'contest', rulesetId: 'nope' as RulesetId, candidateIds: ['c1'] }, c1), TypeError)
  assert.throws(() => validateBallot({ id: 'contest', rulesetId: 'at-school-speaker-v1', candidateIds: ['c1', 'c1'] }, c1), TypeError)
  assert.throws(() => validateBallot({ id: 'contest', rulesetId: 'at-school-speaker-v1', candidateIds: [] }, confirmedInvalid([])), RangeError)
  for (const id of ['', undefined, 7]) {
    assert.throws(
      () => validateBallot({ id, rulesetId: 'at-school-speaker-v1', candidateIds: ['c1'] } as unknown as Contest, c1),
      TypeError,
    )
  }
  // A hole, a non-string, an empty id, and no array at all.
  for (const candidateIds of [
    ['c1', , 'c3'],
    ['c1', 2, 'c3'],
    ['c1', ''],
    'c1',
  ]) {
    assert.throws(
      () => validateBallot({ id: 'contest', rulesetId: 'at-school-speaker-v1', candidateIds } as unknown as Contest, c1),
      TypeError,
    )
  }
})
