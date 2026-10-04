// The count without a database: stored rows become election-core's
// ballots again, the digest depends on the content alone, and the result
// and outcome come out the same for the same input.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TALLY_VERSION, validateBallot, type Contest } from '@school-election/election-core'
import { ballotsOf, inputDigest, tallyContest, TallyError } from '../lib/tally.ts'

const A = '0a000000-0000-4000-8000-00000000000a'
const B = '0b000000-0000-4000-8000-00000000000b'
const C = '0c000000-0000-4000-8000-00000000000c'
const REPRESENTATIVE: Contest = { id: '1c000000-0000-4000-8000-000000000001', rulesetId: 'at-representative-v1', candidateIds: [A, B, C] }
const SINGLE: Contest = { id: '1c000000-0000-4000-8000-000000000002', rulesetId: 'single-choice-v1', candidateIds: [A] }

test('stored rows become the ballots the voters cast: a ranking, a "Nein" and a confirmed invalid vote', () => {
  const ballots = ballotsOf(REPRESENTATIVE, [
    { kind: 'ranking', ranking: [B, A] },
    { kind: 'invalid', ranking: [] },
  ])
  assert.deepEqual(ballots.map((ballot) => [ballot.kind, [...ballot.ranking]]), [['ranking', [B, A]], ['invalid', []]])
  const no = ballotsOf(SINGLE, [{ kind: 'no', ranking: [] }])
  assert.deepEqual(no.map((ballot) => ballot.kind), ['no'])
})

test('a stored ballot election-core refuses is a hard error, never counted or skipped', () => {
  assert.throws(() => ballotsOf(REPRESENTATIVE, [{ kind: 'ranking', ranking: [A] }]), (err) => err instanceof TallyError && /ballot 0 of contest .* incomplete/.test(err.message))
  assert.throws(() => ballotsOf(REPRESENTATIVE, [{ kind: 'ranking', ranking: [A, B] }, { kind: 'ranking', ranking: [A, A] }]), (err) => err instanceof TallyError && /ballot 1 .* duplicate-candidate/.test(err.message))
  assert.throws(() => ballotsOf(REPRESENTATIVE, [{ kind: 'no', ranking: [] }]), (err) => err instanceof TallyError && /no-not-offered/.test(err.message))
})

function cast(contest: Contest, ...rankings: string[][]) {
  return rankings.map((ranking) => {
    const result = validateBallot(contest, { kind: 'ranking', ranking })
    assert.ok(result.ok)
    return result.ballot
  })
}

test('the digest depends on the content alone: the same ballots in another order give the same digest, one more ballot another', () => {
  const ballots = cast(REPRESENTATIVE, [A, B], [B, C], [A, C], [B, C])
  const digest = inputDigest(REPRESENTATIVE, ballots)
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(inputDigest(REPRESENTATIVE, [...ballots].reverse()), digest)
  assert.equal(inputDigest(REPRESENTATIVE, [ballots[3]!, ballots[1]!, ballots[0]!, ballots[2]!]), digest)
  assert.notEqual(inputDigest(REPRESENTATIVE, ballots.slice(1)), digest)
  assert.notEqual(inputDigest(REPRESENTATIVE, cast(REPRESENTATIVE, [A, B], [B, C], [A, C], [C, B])), digest)
  // The contest is part of the input: another candidate order is another input.
  assert.notEqual(inputDigest({ ...REPRESENTATIVE, candidateIds: [C, B, A] }, ballots), digest)
})

test('the result and the outcome follow from the input; a majority is final, none is a runoff', () => {
  const majority = tallyContest(REPRESENTATIVE, cast(REPRESENTATIVE, [A, B], [A, C], [B, A]))
  assert.equal(majority.ballots, 3)
  assert.equal(majority.result.kind, 'elected')
  assert.equal(majority.outcome.kind, 'final')
  assert.equal(majority.result.statistics.validBallots, 3)
  assert.deepEqual(tallyContest(REPRESENTATIVE, cast(REPRESENTATIVE, [A, B], [A, C], [B, A])), majority)

  const split = tallyContest(REPRESENTATIVE, cast(REPRESENTATIVE, [A, B], [B, C], [C, A], [B, A]))
  assert.equal(split.result.kind, 'runoff-required')
  assert.equal(split.outcome.kind, 'runoff-required')
  assert.notEqual(split.inputSha256, majority.inputSha256)

  assert.equal(TALLY_VERSION, 2, 'a new tally version changes every digest: bump the fixtures and this with it')
})
