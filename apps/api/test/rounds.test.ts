// The round routes: who may open and close, what the lifecycle allows
// before, while and after, what every member sees of turnout and the
// result and when, and the whole first round through the API from a
// prepared election to the result with its trace.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { LightMyRequestResponse } from 'fastify'
import { validateBallot, type CastBallot, type Contest, type Lifecycle } from '@school-election/election-core'
import { castBallot } from '../lib/ballot-box.ts'
import { DB, withClient } from './helpers/db.ts'
import { ANNA, auditActions, CARLA, createElection, electionApp, signIn, WANDA, type Browser, type ElectionApp } from './helpers/elections.ts'

interface Setup {
  s: ElectionApp
  anna: Browser
  carla: Browser
  wanda: Browser
  id: string
  base: string
  contest: Contest
  boxId: string
  credentialIds: string[]
}

const ok = <T>(res: LightMyRequestResponse, status = 200): T => {
  assert.equal(res.statusCode, status, res.body)
  return res.json<T>()
}

const refused = (res: LightMyRequestResponse, status: number, error: string) => {
  assert.equal(res.statusCode, status, res.body)
  assert.equal(res.json<{ error: string }>().error, error)
}

/** A prepared election with the school contest (three candidates) voted in by 1A and 2B, five keys for 1A, Carla as co-admin and Wanda as witness. */
async function prepared(t: TestContext): Promise<Setup> {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const base = `/api/elections/${id}`
  const created = ok<{ id: string }>(await anna.request('POST', `${base}/contests`, { title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1' }), 201)
  for (const [surname, givenName] of [['Berger', 'Paula'], ['Huber', 'Quirin'], ['Wagner', 'Renate']]) {
    ok(await anna.request('POST', `${base}/contests/${created.id}/candidates`, { surname, givenName }), 201)
  }
  for (const name of ['1A', '2B']) {
    const group = ok<{ id: string }>(await anna.request('POST', `${base}/voter-groups`, { name }), 201)
    ok(await anna.request('PUT', `${base}/voter-groups/${group.id}/contests`, { contestIds: [created.id] }))
    if (name === '1A') ok(await anna.request('POST', `${base}/prepare`))
    if (name === '1A') ok(await anna.request('POST', `${base}/unprepare`))
  }
  for (const [person, role] of [[CARLA, 'admin'], [WANDA, 'witness']] as const) {
    ok(await anna.request('POST', `${base}/members`, { email: person.email, role }), 201)
  }
  const carla = await signIn(s, CARLA)
  const wanda = await signIn(s, WANDA)
  ok(await anna.request('POST', `${base}/prepare`))
  const groups = ok<{ voterGroups: { id: string, name: string }[], contests: { id: string, candidates: { id: string }[] }[] }>(await anna.request('GET', `${base}/configuration`))
  const g1a = groups.voterGroups.find((group) => group.name === '1A')!
  ok(await anna.request('POST', `${base}/batches`, { voterGroupId: g1a.id, roundKind: 'regular', count: 5 }), 201)
  const contest: Contest = { id: created.id, rulesetId: 'at-school-speaker-v1', candidateIds: groups.contests[0]!.candidates.map((candidate) => candidate.id) }
  const { boxId, credentialIds } = await withClient(s.ownerUrl, async (client) => ({
    boxId: (await client.query<{ id: string }>('select id from round_contest where election_id = $1', [id])).rows[0]!.id,
    credentialIds: (await client.query<{ id: string }>('select c.id from credential c join credential_batch b on b.id = c.batch_id where b.election_id = $1 and b.state = $2 order by c.key', [id, 'issued'])).rows.map((row) => row.id),
  }))
  return { s, anna, carla, wanda, id, base, contest, boxId, credentialIds }
}

const ranking = (contest: Contest, order: string[]): CastBallot => {
  const result = validateBallot(contest, { kind: 'ranking', ranking: order })
  assert.ok(result.ok, JSON.stringify(result))
  return result.ballot
}

const vote = (x: Setup, credentialId: string, order: string[]) =>
  x.s.db.tx((client) => castBallot(client, { credentialId, roundContestId: x.boxId, contest: x.contest, ballot: ranking(x.contest, order) }))

const lifecycleOf = async (by: Browser, base: string) => ok<{ state: string, lifecycle: Lifecycle }>(await by.request('GET', base))

test('opening: those who run rounds, from prepared only, once; then the structure, the candidates and the keys are fixed', DB, async (t) => {
  const x = await prepared(t)
  refused(await x.wanda.request('POST', `${x.base}/rounds/regular/open`), 403, 'forbidden')
  const draft = await createElection(x.anna, 'Noch ein Entwurf')
  refused(await x.anna.request('POST', `/api/elections/${draft}/rounds/regular/open`), 409, 'not_prepared')
  refused(await x.anna.request('POST', `${x.base}/rounds/regular/close`), 409, 'round_planned')

  assert.deepEqual(ok(await x.carla.request('POST', `${x.base}/rounds/regular/open`)), { election: 'active', round: 'open' })
  const detail = await lifecycleOf(x.wanda, x.base)
  assert.equal(detail.state, 'active')
  assert.deepEqual(detail.lifecycle, { election: 'active', regular: 'open', runoff: null })
  refused(await x.anna.request('POST', `${x.base}/rounds/regular/open`), 409, 'voting_started')
  refused(await x.anna.request('POST', `${x.base}/unprepare`), 409, 'voting_started')

  const [candidate] = x.contest.candidateIds
  refused(await x.anna.request('PATCH', `${x.base}/candidates/${candidate}`, { surname: 'Anders', givenName: 'Paula' }), 409, 'voting_started')
  refused(await x.anna.request('POST', `${x.base}/contests`, { title: 'Noch einer', rulesetId: 'single-choice-v1' }), 409, 'not_draft')
  const { voterGroups } = ok<{ voterGroups: { id: string, name: string }[] }>(await x.anna.request('GET', `${x.base}/configuration`))
  refused(await x.anna.request('POST', `${x.base}/batches`, { voterGroupId: voterGroups[0]!.id, roundKind: 'regular', count: 3 }), 409, 'voting_started')
  assert.deepEqual((await auditActions(x.anna, x.id)).slice(-1), ['round.opened'])
})

test('no role sees a result while the round is open; everyone sees turnout, as counts only', DB, async (t) => {
  const x = await prepared(t)
  for (const by of [x.anna, x.carla, x.wanda]) refused(await by.request('GET', `${x.base}/rounds/regular/result`), 409, 'round_planned')
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  for (const by of [x.anna, x.carla, x.wanda]) refused(await by.request('GET', `${x.base}/rounds/regular/result`), 409, 'round_open')

  const [first, second] = x.credentialIds as [string, string]
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  assert.deepEqual(await vote(x, first, [paula, quirin, renate]), { cast: true })
  assert.deepEqual(await vote(x, second, [paula, renate, quirin]), { cast: true })
  for (const by of [x.anna, x.carla, x.wanda]) {
    const turnout = ok<{ round: string, keys: { issued: number, used: number }, contests: { contestId: string, issued: number, used: number }[] }>(await by.request('GET', `${x.base}/rounds/regular/turnout`))
    assert.deepEqual(turnout, { round: 'open', keys: { issued: 5, used: 2 }, contests: [{ contestId: x.contest.id, issued: 5, used: 2 }] })
  }
})

test('closing seals and counts: the result for every member from then on, a vote after it refused, and the log complete', DB, async (t) => {
  const x = await prepared(t)
  ok(await x.anna.request('POST', `${x.base}/rounds/regular/open`))
  const [first, second, third, fourth, fifth] = x.credentialIds as [string, string, string, string, string]
  const [paula, quirin, renate] = x.contest.candidateIds as [string, string, string]
  for (const [key, order] of [[first, [paula, quirin, renate]], [second, [paula, renate, quirin]], [third, [paula, quirin, renate]], [fourth, [quirin, paula, renate]]] as const) {
    assert.deepEqual(await vote(x, key, [...order]), { cast: true })
  }

  refused(await x.wanda.request('POST', `${x.base}/rounds/regular/close`), 403, 'forbidden')
  const closed = ok<{ election: string, round: string, ballots: number, contests: { contestId: string, outcome: string }[] }>(await x.anna.request('POST', `${x.base}/rounds/regular/close`))
  assert.deepEqual(closed, { election: 'active', round: 'closed', ballots: 4, contests: [{ contestId: x.contest.id, outcome: 'final' }] })
  refused(await x.anna.request('POST', `${x.base}/rounds/regular/close`), 409, 'round_closed')
  assert.deepEqual(await vote(x, fifth, [paula, quirin, renate]), { cast: false, reason: 'refused' })
  assert.deepEqual((await lifecycleOf(x.wanda, x.base)).lifecycle, { election: 'active', regular: 'closed', runoff: null })

  interface Stored {
    round: string
    contests: {
      contestId: string
      inputSha256: string
      tallyVersion: number
      appVersion: string
      gitSha: string
      result: { kind: string, winnerId?: string, statistics: { validBallots: number, candidates: { candidateId: string, firstPlaces: number, points: number }[] }, trace: { kind: string }[] }
      outcome: { kind: string, positions?: { candidateId: string }[] }
    }[]
  }
  let seen: Stored | undefined
  for (const by of [x.anna, x.carla, x.wanda]) {
    const stored = ok<Stored>(await by.request('GET', `${x.base}/rounds/regular/result`))
    if (seen) assert.deepEqual(stored, seen)
    seen = stored
  }
  assert.ok(seen)
  assert.equal(seen.round, 'closed')
  const [result] = seen.contests
  assert.ok(result)
  assert.equal(result.contestId, x.contest.id)
  assert.match(result.inputSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual({ tallyVersion: result.tallyVersion, appVersion: result.appVersion, gitSha: result.gitSha }, { tallyVersion: 2, appVersion: 'dev', gitSha: 'unknown' })
  assert.equal(result.result.kind, 'elected')
  assert.equal(result.result.winnerId, paula)
  assert.equal(result.result.statistics.validBallots, 4)
  // Three candidates: three active slots of six, five and four points.
  assert.deepEqual(result.result.statistics.candidates.map((candidate) => [candidate.candidateId, candidate.firstPlaces, candidate.points]), [[paula, 3, 23], [quirin, 1, 20], [renate, 0, 17]])
  assert.ok(result.result.trace.length > 0)
  assert.equal(result.outcome.kind, 'final')
  assert.equal(result.outcome.positions?.[0]?.candidateId, paula)

  const turnout = ok<{ round: string, keys: { issued: number, used: number } }>(await x.wanda.request('GET', `${x.base}/rounds/regular/turnout`))
  assert.deepEqual([turnout.round, turnout.keys], ['closed', { issued: 5, used: 4 }])
  assert.deepEqual((await auditActions(x.anna, x.id)).slice(-3), ['round.opened', 'round.closed', 'result.computed'])

  // A closed round whose snapshots are gone (a database changed by hand) is an error, never an empty result.
  await withClient(x.s.ownerUrl, (client) => client.query('begin; set local session_replication_role = replica; delete from result_snapshot; commit'))
  refused(await x.wanda.request('GET', `${x.base}/rounds/regular/result`), 500, 'internal_error')
})
