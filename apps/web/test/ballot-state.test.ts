import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateBallot } from '@school-election/election-core'
import { emptyBallot, fromBallot, place, pool, rankingOf, review, rowOf, toSend } from '../src/voter/ballot-state.ts'
import type { VoterContest } from '../src/voter/voter-api.ts'
import { coreContest } from '../src/voter/voter-rules.ts'

function contest(rulesetId: VoterContest['rulesetId'], candidates: number): Pick<VoterContest, 'id' | 'rulesetId' | 'candidates'> {
  return {
    id: 'c1',
    rulesetId,
    candidates: Array.from({ length: candidates }, (_, n) => ({ id: `k${n}`, surname: `S${n}`, givenName: `G${n}`, picture: null })),
  }
}

test('a ballot has one row per active slot, 1 to 6, and seven candidates leave a pool', () => {
  for (const [candidates, rows] of [[1, 1], [2, 2], [3, 3], [4, 4], [6, 6], [7, 6]] as const) {
    assert.equal(emptyBallot(contest('at-school-speaker-v1', candidates)).slots.length, rows, `${candidates} candidates`)
  }
  const seven = contest('at-school-speaker-v1', 7)
  let state = emptyBallot(seven)
  assert.equal(pool(seven, state).length, 7)
  for (let rank = 1; rank <= 6; rank += 1) state = place(state, rank, `k${rank - 1}`)
  assert.deepEqual(pool(seven, state).map((candidate) => candidate.id), ['k6'], 'the one not ranked gets no points')
  assert.deepEqual(review(seven, rankingOf(state)), { kind: 'valid' })
})

test('placing a candidate who sits in another row moves them; placing nothing empties the row', () => {
  const three = contest('at-school-speaker-v1', 3)
  let state = place(place(emptyBallot(three), 1, 'k0'), 2, 'k1')
  assert.deepEqual(state.slots, ['k0', 'k1', null])
  state = place(state, 1, 'k1')
  assert.deepEqual(state.slots, ['k1', null, null], 'k1 moved up, row 2 emptied')
  assert.equal(rowOf(state, 'k1'), 1)
  assert.equal(rowOf(state, 'k0'), undefined)
  state = place(state, 1, null)
  assert.deepEqual(state.slots, [null, null, null])
  assert.throws(() => place(state, 4, 'k0'), RangeError)
  assert.throws(() => place(state, 0, 'k0'), RangeError)
})

test('the review says valid exactly when election-core accepts the ranking, and counts the empty rows otherwise', () => {
  const three = contest('at-school-speaker-v1', 3)
  const full = place(place(place(emptyBallot(three), 1, 'k2'), 2, 'k0'), 3, 'k1')
  assert.deepEqual(review(three, rankingOf(full)), { kind: 'valid' })
  assert.equal(validateBallot(coreContest(three), rankingOf(full)).ok, true)
  const oneEmpty = place(full, 2, null)
  assert.deepEqual(review(three, rankingOf(oneEmpty)), { kind: 'invalid', empty: 1, of: 3 })
  assert.equal(validateBallot(coreContest(three), rankingOf(oneEmpty)).ok, false, 'the API refuses it without the confirmation')
  assert.deepEqual(review(three, rankingOf(emptyBallot(three))), { kind: 'invalid', empty: 3, of: 3 }, 'an empty ballot is an invalid vote')
  assert.deepEqual(review(contest('at-representative-v1', 1), { kind: 'no' }), { kind: 'no' })
  assert.throws(() => review(three, { kind: 'ranking', ranking: ['k0', 'k0', 'k1'] }), /refuses/)
})

test('what is sent carries the confirmation only when asked, and a ballot comes back into its rows for correcting', () => {
  const three = contest('at-school-speaker-v1', 3)
  const ranking = rankingOf(place(emptyBallot(three), 1, 'k0'))
  assert.deepEqual(toSend(ranking, false), { kind: 'ranking', ranking: ['k0', null, null] })
  assert.deepEqual(toSend(ranking, true), { kind: 'ranking', ranking: ['k0', null, null], confirmInvalid: true })
  assert.deepEqual(toSend({ kind: 'no' }, true), { kind: 'no' })
  assert.deepEqual(toSend({ kind: 'ranking', ranking: ['k0', 'k1', 'k2'], confirmInvalid: true }, false), { kind: 'ranking', ranking: ['k0', 'k1', 'k2'] })
  assert.deepEqual(fromBallot(three, ranking).slots, ['k0', null, null])
  assert.deepEqual(fromBallot(three, { kind: 'no' }).slots, [null, null, null])
  assert.deepEqual(fromBallot(three, undefined).slots, [null, null, null])
  assert.deepEqual(fromBallot(three, { kind: 'ranking', ranking: ['k0'] }).slots, [null, null, null], 'a ranking of another length is not this ballot')
})
