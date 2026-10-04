// What the tests of the round routes start from: a prepared election with
// one contest and its candidates, classes voting in it, keys issued for
// the first class, Carla as co-admin and Wanda as witness, all signed in,
// and the ids a test votes with; and the small helpers over inject's
// answers and over casting a ballot as the voter route will.

import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { LightMyRequestResponse } from 'fastify'
import { validateBallot, type CastBallot, type Contest, type Lifecycle, type RulesetId } from '@school-election/election-core'
import { castBallot, type CastResult } from '../../lib/ballot-box.ts'
import { inOrder } from '../../lib/in-order.ts'
import { withClient } from './db.ts'
import { ANNA, CARLA, createElection, electionApp, signIn, WANDA, type Browser, type ElectionApp } from './elections.ts'

export interface RouteSetup {
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

export interface ElectionShape {
  title: string
  rulesetId: RulesetId
  /** Surname and given name each, in the order entered; the ballot sorts them. */
  candidates: readonly (readonly [string, string])[]
  /** The classes, each voting in the contest; keys are issued for the first. */
  groups: readonly string[]
  keys: number
}

export const ok = <T>(res: LightMyRequestResponse, status = 200): T => {
  assert.equal(res.statusCode, status, res.body)
  return res.json<T>()
}

export const refused = (res: LightMyRequestResponse, status: number, error: string): void => {
  assert.equal(res.statusCode, status, res.body)
  assert.equal(res.json<{ error: string }>().error, error)
}

/** A prepared election of the given shape, through the API as Anna, with the members signed in. */
export async function preparedElection(t: TestContext, shape: ElectionShape): Promise<RouteSetup> {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const base = `/api/elections/${id}`
  const created = ok<{ id: string }>(await anna.request('POST', `${base}/contests`, { title: shape.title, rulesetId: shape.rulesetId }), 201)
  await inOrder(shape.candidates, async ([surname, givenName]) => {
    ok(await anna.request('POST', `${base}/contests/${created.id}/candidates`, { surname, givenName }), 201)
  })
  const groupIds: string[] = []
  await inOrder(shape.groups, async (name) => {
    const group = ok<{ id: string }>(await anna.request('POST', `${base}/voter-groups`, { name }), 201)
    ok(await anna.request('PUT', `${base}/voter-groups/${group.id}/contests`, { contestIds: [created.id] }))
    groupIds.push(group.id)
  })
  await inOrder([[CARLA, 'admin'], [WANDA, 'witness']] as const, async ([person, role]) => {
    ok(await anna.request('POST', `${base}/members`, { email: person.email, role }), 201)
  })
  const carla = await signIn(s, CARLA)
  const wanda = await signIn(s, WANDA)
  ok(await anna.request('POST', `${base}/prepare`))
  ok(await anna.request('POST', `${base}/batches`, { voterGroupId: groupIds[0], roundKind: 'regular', count: shape.keys }), 201)
  const configuration = ok<{ contests: { id: string, candidates: { id: string }[] }[] }>(await anna.request('GET', `${base}/configuration`))
  const contest: Contest = { id: created.id, rulesetId: shape.rulesetId, candidateIds: configuration.contests[0]!.candidates.map((candidate) => candidate.id) }
  const { boxId, credentialIds } = await withClient(s.ownerUrl, async (client) => ({
    boxId: (await client.query<{ id: string }>('select id from round_contest where election_id = $1', [id])).rows[0]!.id,
    credentialIds: (await client.query<{ id: string }>(
      'select c.id from credential c join credential_batch b on b.id = c.batch_id where b.election_id = $1 and b.state = $2 order by c.key',
      [id, 'issued'],
    )).rows.map((row) => row.id),
  }))
  return { s, anna, carla, wanda, id, base, contest, boxId, credentialIds }
}

/** A complete ranking for the contest, validated. */
export function ranking(contest: Contest, order: string[]): CastBallot {
  const result = validateBallot(contest, { kind: 'ranking', ranking: order })
  assert.ok(result.ok, JSON.stringify(result))
  return result.ballot
}

/** Casts a ballot with the key, in a transaction of its own, as the voter route will. */
export const vote = (x: RouteSetup, credentialId: string, order: string[]): Promise<CastResult> =>
  x.s.db.tx((client) => castBallot(client, { credentialId, roundContestId: x.boxId, contest: x.contest, ballot: ranking(x.contest, order) }))

/** The election as `by` sees it, with its lifecycle. */
export const lifecycleOf = async (by: Browser, base: string): Promise<{ state: string, lifecycle: Lifecycle }> =>
  ok<{ state: string, lifecycle: Lifecycle }>(await by.request('GET', base))
