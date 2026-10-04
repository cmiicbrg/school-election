// The test mode and deletion through the routes: who may, what a running
// test freezes, the test result for every member and for nobody else,
// what ending restores, that opening ends a test, and that nothing of a
// test reaches the real count; and that an unused election is deleted by
// its owner alone.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DB, withClient } from './helpers/db.ts'
import { auditActions, createElection } from './helpers/elections.ts'
import { lifecycleOf, ok, oneContest, preparedElection, refused, vote, type RouteSetup } from './helpers/round-routes.ts'

/** The class contest with two candidates, voted in by 1A, three keys. */
const prepared = (t: TestContext): Promise<RouteSetup> => preparedElection(t, oneContest({
  title: 'Klassensprecher/in',
  rulesetId: 'at-representative-v1',
  candidates: [['Berger', 'Paula'], ['Huber', 'Quirin']],
}, ['1A'], 3))

interface Counted { round: string, contests: { contestId: string, result: { statistics: { validBallots: number } }, outcome: { kind: string } }[] }

test('a test starts on a prepared election, for those who run rounds; while it runs, candidates, keys, unpreparing and the real result wait', DB, async (t) => {
  const x = await prepared(t)
  refused(await x.wanda.request('POST', `${x.base}/rounds/regular/test`), 403, 'forbidden')
  const draft = await createElection(x.anna, 'Entwurf')
  refused(await x.anna.request('POST', `/api/elections/${draft}/rounds/regular/test`), 409, 'not_prepared')
  refused(await x.anna.request('POST', `${x.base}/rounds/regular/test/end`), 409, 'round_planned')
  for (const by of [x.anna, x.carla, x.wanda]) refused(await by.request('GET', `${x.base}/rounds/regular/test-result`), 409, 'round_planned')

  assert.deepEqual(ok(await x.carla.request('POST', `${x.base}/rounds/regular/test`)), { election: 'prepared', round: 'testing' })
  assert.deepEqual((await lifecycleOf(x.wanda, x.base)).lifecycle, { election: 'prepared', regular: 'testing', runoff: null })
  refused(await x.anna.request('POST', `${x.base}/rounds/regular/test`), 409, 'round_testing')
  refused(await x.anna.request('POST', `${x.base}/unprepare`), 409, 'round_testing')
  refused(await x.anna.request('POST', `${x.base}/rounds/regular/close`), 409, 'round_testing')
  refused(await x.anna.request('PATCH', `${x.base}/candidates/${x.contest.candidateIds[0]}`, { surname: 'Anders', givenName: 'Paula' }), 409, 'round_testing')
  refused(await x.anna.request('PATCH', x.base, { title: 'Anders' }), 409, 'round_testing')
  const { voterGroups } = ok<{ voterGroups: { id: string }[] }>(await x.anna.request('GET', `${x.base}/configuration`))
  refused(await x.anna.request('POST', `${x.base}/batches`, { voterGroupId: voterGroups[0]!.id, roundKind: 'regular', count: 2 }), 409, 'round_testing')
  refused(await x.anna.request('DELETE', x.base), 409, 'round_testing')
  for (const by of [x.anna, x.carla, x.wanda]) refused(await by.request('GET', `${x.base}/rounds/regular/result`), 409, 'round_testing')
  // Members may still be invited.
  ok(await x.anna.request('POST', `${x.base}/members`, { email: 'zeuge2@schule.example.org', role: 'witness' }), 201)
})

test('the test result shows the test\'s ballots to every member; ending restores everything and audits the counts', DB, async (t) => {
  const x = await prepared(t)
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/test`))
  const [first, second] = x.credentialIds as [string, string]
  const [paula, quirin] = x.contest.candidateIds as [string, string]
  assert.deepEqual(await vote(x, first, [paula, quirin]), { cast: true })
  assert.deepEqual(await vote(x, second, [paula, quirin]), { cast: true })
  for (const by of [x.anna, x.carla, x.wanda]) {
    const counted = ok<Counted>(await by.request('GET', `${x.base}/rounds/regular/test-result`))
    assert.equal(counted.round, 'testing')
    assert.deepEqual(counted.contests.map((contest) => [contest.contestId, contest.result.statistics.validBallots, contest.outcome.kind]), [[x.contest.id, 2, 'final']])
  }
  const turnout = async () => ok<{ keys: { issued: number, used: number } }>(await x.wanda.request('GET', `${x.base}/rounds/regular/turnout`))
  assert.deepEqual((await turnout()).keys, { issued: 3, used: 2 })

  refused(await x.wanda.request('POST', `${x.base}/rounds/regular/test/end`), 403, 'forbidden')
  assert.deepEqual(ok(await x.anna.request('POST', `${x.base}/rounds/regular/test/end`)), { election: 'prepared', round: 'planned', ballots: 2, keys: 2 })
  assert.deepEqual((await turnout()).keys, { issued: 3, used: 0 })
  assert.deepEqual((await lifecycleOf(x.anna, x.base)).lifecycle, { election: 'prepared', regular: 'planned', runoff: null })
  assert.deepEqual(await vote(x, first, [paula, quirin]), { cast: false, reason: 'refused' })
  assert.deepEqual((await auditActions(x.anna, x.id)).slice(-2), ['test.started', 'test.ended'])
  // Keys can be issued again, candidates corrected, and a second test started.
  ok(await x.anna.request('PATCH', `${x.base}/candidates/${paula}`, { surname: 'Berger-Huber', givenName: 'Paula' }))
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/test`))
})

test('opening from a test ends it first, and the real count holds the real ballots alone', DB, async (t) => {
  const x = await prepared(t)
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/test`))
  const [first, second, third] = x.credentialIds as [string, string, string]
  const [paula, quirin] = x.contest.candidateIds as [string, string]
  assert.deepEqual(await vote(x, first, [quirin, paula]), { cast: true })
  assert.deepEqual(await vote(x, second, [quirin, paula]), { cast: true })
  assert.deepEqual(ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`)), { election: 'active', round: 'open' })
  assert.deepEqual((await auditActions(x.anna, x.id)).slice(-3), ['test.started', 'test.ended', 'round.opened'])
  // The keys that voted in the test vote again, for real, and one more.
  for (const key of [first, second, third]) assert.deepEqual(await vote(x, key, [paula, quirin]), { cast: true })
  const closed = ok<{ ballots: number, contests: { outcome: string }[] }>(await x.anna.request('POST', `${x.base}/rounds/regular/close`))
  assert.deepEqual([closed.ballots, closed.contests[0]?.outcome], [3, 'final'])
  const stored = ok<Counted>(await x.wanda.request('GET', `${x.base}/rounds/regular/result`))
  const [result] = stored.contests
  assert.equal(result?.result.statistics.validBallots, 3)
  assert.equal((result?.result as { winnerId?: string }).winnerId, paula)
  refused(await x.anna.request('GET', `${x.base}/rounds/regular/test-result`), 409, 'round_closed')
})

test('an unused election is deleted by its owner alone, and is gone with its log', DB, async (t) => {
  const x = await prepared(t)
  refused(await x.carla.request('DELETE', x.base), 403, 'forbidden')
  refused(await x.wanda.request('DELETE', x.base), 403, 'forbidden')
  assert.equal((await x.anna.request('DELETE', x.base)).statusCode, 204)
  refused(await x.anna.request('GET', x.base), 404, 'not_found')
  refused(await x.wanda.request('GET', `${x.base}/audit`), 404, 'not_found')
  assert.deepEqual(ok<{ id: string }[]>(await x.anna.request('GET', '/api/elections')).map((election) => election.id), [])
  const { rows } = await withClient(x.s.ownerUrl, (client) => client.query<{ n: number }>('select count(*)::int as n from audit_event where election_id = $1', [x.id]))
  assert.equal(rows[0]?.n, 0)

  const y = await prepared(t)
  ok(await y.anna.request('POST', `${y.base}/rounds/regular/open`))
  refused(await y.anna.request('DELETE', y.base), 409, 'voting_started')
})
