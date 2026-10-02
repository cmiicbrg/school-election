import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBlank, validateBallot, type BallotError, type Contest, type RulesetId } from '../src/index.ts'
import { permutations } from './helpers/prng.ts'

function contest(candidates: number, rulesetId: RulesetId = 'at-school-speaker-v1'): Contest {
  return { rulesetId, candidateIds: Array.from({ length: candidates }, (_, i) => `c${i + 1}`) }
}

function rejection(c: Contest, input: unknown): BallotError {
  const result = validateBallot(c, input)
  assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be rejected`)
  return (result as { error: BallotError }).error
}

test('a complete ballot is accepted and keeps its order', () => {
  const result = validateBallot(contest(4), ['c3', 'c1', 'c4', 'c2'])
  assert.ok(result.ok)
  assert.deepEqual(result.ballot.ranking, ['c3', 'c1', 'c4', 'c2'])
  assert.ok(Object.isFrozen(result.ballot.ranking))
})

test('the validated ranking is a copy, not the caller\'s array', () => {
  const input = ['c1', 'c2']
  const result = validateBallot(contest(2), input)
  assert.ok(result.ok)
  input[0] = 'c2'
  assert.deepEqual(result.ballot.ranking, ['c1', 'c2'])
})

test('a duplicate candidate is rejected', () => {
  assert.deepEqual(rejection(contest(3), ['c1', 'c2', 'c1']), { kind: 'duplicate-candidate', position: 2 })
})

test('an unknown candidate is rejected', () => {
  assert.deepEqual(rejection(contest(3), ['c1', 'c9', 'c2']), { kind: 'unknown-candidate', position: 1 })
  assert.deepEqual(rejection(contest(2), ['', 'c1']), { kind: 'unknown-candidate', position: 0 })
})

test('malformed payloads are rejected', () => {
  const c = contest(3)
  for (const input of [undefined, null, 'c1', 42, { 0: 'c1', 1: 'c2', 2: 'c3', length: 3 }, new Set(['c1'])]) {
    assert.deepEqual(rejection(c, input), { kind: 'malformed', reason: 'not-an-array' })
  }
  for (const input of [['c1', null, 'c2'], ['c1', 2, 'c3'], [['c1'], 'c2', 'c3'], [{ id: 'c1' }, 'c2', 'c3']]) {
    assert.deepEqual(rejection(c, input), { kind: 'malformed', reason: 'non-string-entry' })
  }
  assert.deepEqual(rejection(c, ['c1', , 'c3']), { kind: 'malformed', reason: 'sparse-array' })
})

test('a duplicate slot cannot be expressed: slot maps are rejected, not interpreted', () => {
  // The ballot is a list whose position is the slot, so no input can give two
  // candidates the same slot or one candidate two slots without repeating it.
  // Map- or object-shaped ballots that could say "6 → c1, 6 → c2" are not
  // accepted in any form.
  const c = contest(3)
  assert.deepEqual(rejection(c, { 6: 'c1', 5: 'c2', 4: 'c3' }), { kind: 'malformed', reason: 'not-an-array' })
  assert.deepEqual(rejection(c, new Map([[6, 'c1'], [5, 'c2']])), { kind: 'malformed', reason: 'not-an-array' })
  assert.deepEqual(rejection(c, [['c1', 6], ['c2', 6], ['c3', 4]]), { kind: 'malformed', reason: 'non-string-entry' })
})

test('four candidates: assigning only 6 and 5 points is an incomplete ballot', () => {
  assert.deepEqual(rejection(contest(4), ['c1', 'c2']), { kind: 'incomplete', activeSlots: 4, entries: 2 })
})

test('four candidates: a fifth entry would fill the inactive 2-point slot', () => {
  assert.deepEqual(rejection(contest(4), ['c1', 'c2', 'c3', 'c4', 'c1']), { kind: 'inactive-slot', activeSlots: 4, entries: 5 })
  assert.deepEqual(rejection(contest(4), ['c1', 'c2', 'c3', 'c4', 'c1', 'c2']), { kind: 'inactive-slot', activeSlots: 4, entries: 6 })
})

test('more than six candidates: exactly six distinct rankings, the rest stay unranked', () => {
  const c = contest(10)
  assert.ok(validateBallot(c, ['c10', 'c2', 'c7', 'c4', 'c5', 'c1']).ok)
  assert.deepEqual(rejection(c, ['c1', 'c2', 'c3', 'c4', 'c5']), { kind: 'incomplete', activeSlots: 6, entries: 5 })
  assert.deepEqual(rejection(c, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']), { kind: 'inactive-slot', activeSlots: 6, entries: 7 })
})

test('an empty ballot is a blank ballot in every contest, whatever the candidate count', () => {
  for (const rulesetId of ['at-school-speaker-v1', 'at-representative-v1', 'single-choice-v1'] as const) {
    for (const n of [1, 2, 4, 6, 10]) {
      const result = validateBallot(contest(n, rulesetId), [])
      assert.ok(result.ok, `${rulesetId} with ${n} candidates`)
      assert.ok(isBlank(result.ballot))
    }
  }
  const complete = validateBallot(contest(2), ['c1', 'c2'])
  assert.ok(complete.ok && !isBlank(complete.ballot))
})

test('representative contests require one ranking per active slot', () => {
  assert.ok(validateBallot(contest(1, 'at-representative-v1'), ['c1']).ok)
  assert.ok(validateBallot(contest(5, 'at-representative-v1'), ['c4', 'c2']).ok)
  assert.deepEqual(rejection(contest(5, 'at-representative-v1'), ['c4']), { kind: 'incomplete', activeSlots: 2, entries: 1 })
  assert.deepEqual(rejection(contest(5, 'at-representative-v1'), ['c4', 'c2', 'c1']), { kind: 'inactive-slot', activeSlots: 2, entries: 3 })
})

test('single-choice contests take exactly one candidate', () => {
  const c = contest(2, 'single-choice-v1')
  assert.ok(validateBallot(c, ['c2']).ok)
  assert.deepEqual(rejection(c, ['c1', 'c2']), { kind: 'inactive-slot', activeSlots: 1, entries: 2 })
})

// Exhaustive completeness for every candidate count up to six: each
// permutation of all candidates is valid, and each of its non-empty proper
// prefixes is rejected as incomplete. A partly filled ballot never becomes a
// blank one; only the empty ballot is blank.
for (let n = 1; n <= 6; n++) {
  test(`${n} candidates: all ${permutations(contest(n).candidateIds).length} complete orderings pass, every partial one fails`, () => {
    const c = contest(n)
    for (const ordering of permutations(c.candidateIds)) {
      assert.ok(validateBallot(c, ordering).ok)
      for (let length = 1; length < n; length++) {
        assert.deepEqual(rejection(c, ordering.slice(0, length)), { kind: 'incomplete', activeSlots: n, entries: length })
      }
    }
  })
}

test('errors never contain candidate ids', () => {
  const c = contest(3)
  for (const input of [['c1', 'c1', 'c2'], ['c1', 'secret-id', 'c2'], ['c1'], ['c1', 'c2', 'c3', 'c1']]) {
    const error = JSON.stringify(rejection(c, input))
    assert.doesNotMatch(error, /c\d|secret-id/)
  }
})

test('an invalid contest is a programming error, not a ballot error', () => {
  assert.throws(() => validateBallot({ rulesetId: 'nope' as RulesetId, candidateIds: ['c1'] }, ['c1']), TypeError)
  assert.throws(() => validateBallot({ rulesetId: 'at-school-speaker-v1', candidateIds: ['c1', 'c1'] }, ['c1']), TypeError)
  assert.throws(() => validateBallot({ rulesetId: 'at-school-speaker-v1', candidateIds: [] }, []), RangeError)
  // A hole, a non-string, an empty id, and no array at all.
  for (const candidateIds of [
    ['c1', , 'c3'],
    ['c1', 2, 'c3'],
    ['c1', ''],
    'c1',
  ]) {
    assert.throws(
      () => validateBallot({ rulesetId: 'at-school-speaker-v1', candidateIds } as unknown as Contest, ['c1']),
      TypeError,
    )
  }
})
