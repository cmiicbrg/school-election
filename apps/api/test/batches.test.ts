// The batch routes: counts for every member, keys for those who may see
// them, issuing and replacing within their windows, and a key nowhere but
// in the one response field declared for it.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { LightMyRequestResponse } from 'fastify'
import { parseKey, type RoundKind } from '@school-election/election-core'
import { DB } from './helpers/db.ts'
import { ANNA, auditActions, CARLA, createElection, electionApp, forceElectionState, forceRoundState, signIn, WANDA, type Browser, type ElectionApp } from './helpers/elections.ts'

interface Setup {
  s: ElectionApp
  anna: Browser
  carla: Browser
  wanda: Browser
  id: string
  base: string
  g1a: string
  g2b: string
}

interface BatchSummary {
  id: string
  voterGroupId: string
  roundKind: RoundKind
  state: 'issued' | 'void'
  keys: number
}

interface BatchKeys {
  batch: BatchSummary
  keys: { key: string, used: boolean | null }[]
}

const ok = <T>(res: LightMyRequestResponse, status = 200): T => {
  assert.equal(res.statusCode, status, res.body)
  return res.json<T>()
}

const refused = (res: LightMyRequestResponse, status: number, error: string) => {
  assert.equal(res.statusCode, status, res.body)
  assert.equal(res.json<{ error: string }>().error, error)
}

/** A prepared election with one contest and the classes 1A and 2B, Carla as co-admin and Wanda as witness, all signed in. */
async function prepared(t: TestContext): Promise<Setup> {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const base = `/api/elections/${id}`
  const contest = ok<{ id: string }>(await anna.request('POST', `${base}/contests`, { title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1' }), 201)
  for (const surname of ['Berger', 'Huber']) ok(await anna.request('POST', `${base}/contests/${contest.id}/candidates`, { surname, givenName: 'Test' }), 201)
  const group = async (name: string) => {
    const created = ok<{ id: string }>(await anna.request('POST', `${base}/voter-groups`, { name }), 201)
    ok(await anna.request('PUT', `${base}/voter-groups/${created.id}/contests`, { contestIds: [contest.id] }))
    return created.id
  }
  const g1a = await group('1A')
  const g2b = await group('2B')
  for (const [person, role] of [[CARLA, 'admin'], [WANDA, 'witness']] as const) {
    ok(await anna.request('POST', `${base}/members`, { email: person.email, role }), 201)
  }
  const carla = await signIn(s, CARLA)
  const wanda = await signIn(s, WANDA)
  ok(await anna.request('POST', `${base}/prepare`))
  return { s, anna, carla, wanda, id, base, g1a, g2b }
}

const issue = (by: Browser, base: string, voterGroupId: string, roundKind: RoundKind, count: number) =>
  by.request('POST', `${base}/batches`, { voterGroupId, roundKind, count })

const keysOf = (issued: BatchKeys) => issued.keys.map((entry) => entry.key)

test('the election detail carries the lifecycle the guard established', DB, async (t) => {
  const { anna, base } = await prepared(t)
  const detail = ok<{ state: string, lifecycle: unknown }>(await anna.request('GET', base))
  assert.deepEqual([detail.state, detail.lifecycle], ['prepared', { election: 'prepared', regular: 'planned', runoff: null }])
})

test('issuing gives the owner and co-admins the keys at once and every member the counts; no key reaches a list, a log line or the audit log', DB, async (t) => {
  const { s, anna, carla, wanda, base, g1a, g2b } = await prepared(t)
  const first = ok<BatchKeys>(await issue(anna, base, g1a, 'regular', 5), 201)
  assert.deepEqual([first.batch.voterGroupId, first.batch.roundKind, first.batch.state, first.batch.keys], [g1a, 'regular', 'issued', 5])
  assert.equal(first.keys.length, 5)
  for (const { key, used } of first.keys) {
    assert.equal(parseKey(key).ok, true, key)
    assert.equal(used, null)
  }
  const second = ok<BatchKeys>(await issue(carla, base, g2b, 'regular', 3), 201)
  refused(await issue(wanda, base, g2b, 'regular', 1), 403, 'forbidden')

  const keys = [...keysOf(first), ...keysOf(second)]
  const list = await wanda.request('GET', `${base}/batches`)
  const { batches } = ok<{ batches: BatchSummary[] }>(list)
  assert.deepEqual(batches.map((batch) => [batch.voterGroupId, batch.roundKind, batch.state, batch.keys]), [[g1a, 'regular', 'issued', 5], [g2b, 'regular', 'issued', 3]])
  for (const key of keys) {
    assert.equal(list.body.includes(key), false, 'the list carries no key')
    assert.equal((await anna.request('GET', `${base}/audit`)).body.includes(key), false, 'the audit log carries no key')
    assert.equal(s.logs().includes(key), false, 'the log carries no key')
  }
  assert.deepEqual((await auditActions(anna, base.slice('/api/elections/'.length))).slice(-2), ['credential-batch.issued', 'credential-batch.issued'])
})

test('the keys route serves the owner and co-admins any time, a witness once the round has closed, with each key used or unused', DB, async (t) => {
  const { s, anna, carla, wanda, id, base, g1a } = await prepared(t)
  const issued = ok<BatchKeys>(await issue(anna, base, g1a, 'regular', 4), 201)
  const path = `${base}/batches/${issued.batch.id}`
  const read = await anna.request('GET', path)
  assert.equal(read.headers['cache-control'], 'no-store')
  assert.deepEqual(keysOf(ok<BatchKeys>(read)), keysOf(issued))
  assert.deepEqual(keysOf(ok<BatchKeys>(await carla.request('GET', path))), keysOf(issued))
  refused(await wanda.request('GET', path), 403, 'forbidden')
  refused(await anna.request('GET', `${base}/batches/0d3b5a0e-6a43-4c1b-9f5e-3d2c1b0a9f8e`), 404, 'not_found')
  // Reading creates nothing.
  assert.equal(ok<{ batches: BatchSummary[] }>(await anna.request('GET', `${base}/batches`)).batches.length, 1)

  await forceElectionState(s.ownerUrl, id, 'active')
  await forceRoundState(s.ownerUrl, id, 'closed')
  const afterClose = ok<BatchKeys>(await wanda.request('GET', path))
  assert.deepEqual(afterClose.keys.map((entry) => entry.used), [false, false, false, false])
  assert.deepEqual(keysOf(afterClose), keysOf(issued))
})

test('the windows: a draft issues nothing, an open round fixes regular batches and leaves runoff ones, and a bad body changes nothing', DB, async (t) => {
  const { s, anna, id, base, g1a } = await prepared(t)
  ok(await anna.request('POST', `${base}/unprepare`))
  refused(await issue(anna, base, g1a, 'regular', 2), 409, 'not_prepared')
  ok(await anna.request('POST', `${base}/prepare`))
  assert.equal((await issue(anna, base, g1a, 'regular', 0)).statusCode, 400)
  assert.equal((await issue(anna, base, g1a, 'regular', 1001)).statusCode, 400)
  assert.equal((await anna.request('POST', `${base}/batches`, { voterGroupId: g1a, roundKind: 'regular' })).statusCode, 400)
  refused(await issue(anna, base, '0d3b5a0e-6a43-4c1b-9f5e-3d2c1b0a9f8e', 'regular', 2), 404, 'not_found')
  assert.deepEqual(ok<{ batches: BatchSummary[] }>(await anna.request('GET', `${base}/batches`)).batches, [])

  await forceElectionState(s.ownerUrl, id, 'active')
  refused(await issue(anna, base, g1a, 'regular', 2), 409, 'voting_started')
  const runoff = ok<BatchKeys>(await issue(anna, base, g1a, 'runoff', 2), 201)
  assert.deepEqual([runoff.batch.roundKind, runoff.keys.length], ['runoff', 2])
})

test('replacing voids the batch and issues as many new keys; a void batch is not replaced again; once the round is open only runoff batches are', DB, async (t) => {
  const { s, anna, wanda, id, base, g1a } = await prepared(t)
  const issued = ok<BatchKeys>(await issue(anna, base, g1a, 'regular', 4), 201)
  refused(await wanda.request('POST', `${base}/batches/${issued.batch.id}/replace`), 403, 'forbidden')
  const replacement = ok<BatchKeys>(await anna.request('POST', `${base}/batches/${issued.batch.id}/replace`), 201)
  assert.equal(replacement.keys.length, 4)
  assert.notEqual(replacement.batch.id, issued.batch.id)
  assert.deepEqual(keysOf(replacement).filter((key) => keysOf(issued).includes(key)), [])
  assert.equal(ok<BatchKeys>(await anna.request('GET', `${base}/batches/${issued.batch.id}`)).batch.state, 'void')
  refused(await anna.request('POST', `${base}/batches/${issued.batch.id}/replace`), 409, 'batch_void')
  refused(await anna.request('POST', `${base}/batches/0d3b5a0e-6a43-4c1b-9f5e-3d2c1b0a9f8e/replace`), 404, 'not_found')
  assert.deepEqual((await auditActions(anna, id)).slice(-2), ['credential-batch.issued', 'credential-batch.replaced'])

  const runoff = ok<BatchKeys>(await issue(anna, base, g1a, 'runoff', 2), 201)
  await forceElectionState(s.ownerUrl, id, 'active')
  refused(await anna.request('POST', `${base}/batches/${replacement.batch.id}/replace`), 409, 'voting_started')
  assert.equal(ok<BatchKeys>(await anna.request('POST', `${base}/batches/${runoff.batch.id}/replace`), 201).keys.length, 2)
})
