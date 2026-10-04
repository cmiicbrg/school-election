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
  /** The first contest, as election-core sees it. */
  contest: Contest
  /** Every contest, in the order entered. */
  contests: Contest[]
  /** The first contest's ballot box. */
  boxId: string
  /** Each contest's ballot box, by contest id. */
  boxes: Map<string, string>
  /** The first class's keys' credential ids, in key order. */
  credentialIds: string[]
  /** Every class's keys, as printed, in key order. */
  keys: Record<string, string[]>
}

export interface ContestShape {
  title: string
  rulesetId: RulesetId
  /** Surname and given name each, in the order entered; the ballot sorts them. */
  candidates: readonly (readonly [string, string])[]
}

export interface GroupShape {
  name: string
  /** Which contests the class votes in, by their index. */
  contests: readonly number[]
  /** Keys issued for the class; none without. */
  keys?: number
}

export interface ElectionShape {
  contests: readonly ContestShape[]
  groups: readonly GroupShape[]
}

/** The common case: one contest, every class voting in it, keys for the first class. */
export function oneContest(contest: ContestShape, groups: readonly string[], keys: number): ElectionShape {
  return { contests: [contest], groups: groups.map((name, index) => ({ name, contests: [0], ...(index === 0 ? { keys } : {}) })) }
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
  const contestIds: string[] = []
  await inOrder(shape.contests, async (contest) => {
    const created = ok<{ id: string }>(await anna.request('POST', `${base}/contests`, { title: contest.title, rulesetId: contest.rulesetId }), 201)
    contestIds.push(created.id)
    await inOrder(contest.candidates, async ([surname, givenName]) => {
      ok(await anna.request('POST', `${base}/contests/${created.id}/candidates`, { surname, givenName }), 201)
    })
  })
  const groupIds = new Map<string, string>()
  await inOrder(shape.groups, async (group) => {
    const created = ok<{ id: string }>(await anna.request('POST', `${base}/voter-groups`, { name: group.name }), 201)
    ok(await anna.request('PUT', `${base}/voter-groups/${created.id}/contests`, { contestIds: group.contests.map((index) => contestIds[index]) }))
    groupIds.set(group.name, created.id)
  })
  await inOrder([[CARLA, 'admin'], [WANDA, 'witness']] as const, async ([person, role]) => {
    ok(await anna.request('POST', `${base}/members`, { email: person.email, role }), 201)
  })
  const carla = await signIn(s, CARLA)
  const wanda = await signIn(s, WANDA)
  ok(await anna.request('POST', `${base}/prepare`))
  await inOrder(shape.groups.filter((group) => group.keys), async (group) => {
    ok(await anna.request('POST', `${base}/batches`, { voterGroupId: groupIds.get(group.name), roundKind: 'regular', count: group.keys }), 201)
  })
  const configuration = ok<{ contests: { id: string, rulesetId: RulesetId, candidates: { id: string }[] }[] }>(await anna.request('GET', `${base}/configuration`))
  const contests = contestIds.map((contestId) => {
    const stored = configuration.contests.find((contest) => contest.id === contestId)
    assert.ok(stored)
    return { id: contestId, rulesetId: stored.rulesetId, candidateIds: stored.candidates.map((candidate) => candidate.id) } satisfies Contest
  })
  const { boxes, keys } = await withClient(s.ownerUrl, async (client) => {
    const { rows: boxRows } = await client.query<{ id: string, contest_id: string }>('select id, contest_id from round_contest where election_id = $1', [id])
    const { rows: keyRows } = await client.query<{ key: string, name: string }>(
      `select c.key, g.name from credential c join credential_batch b on b.id = c.batch_id join voter_group g on g.id = b.voter_group_id
        where b.election_id = $1 and b.state = $2 order by g.name, c.key`,
      [id, 'issued'],
    )
    const keys: Record<string, string[]> = {}
    for (const row of keyRows) {
      const group = keys[row.name] ?? []
      group.push(row.key)
      keys[row.name] = group
    }
    return { boxes: new Map(boxRows.map((row) => [row.contest_id, row.id])), keys }
  })
  const first = shape.groups[0]?.name ?? ''
  const { rows: firstKeys } = await withClient(s.ownerUrl, (client) => client.query<{ id: string }>(
    `select c.id from credential c join credential_batch b on b.id = c.batch_id join voter_group g on g.id = b.voter_group_id
      where b.election_id = $1 and b.state = $2 and g.name = $3 order by c.key`,
    [id, 'issued', first],
  ))
  const contest = contests[0]
  assert.ok(contest)
  return { s, anna, carla, wanda, id, base, contest, contests, boxId: boxes.get(contest.id) ?? '', boxes, credentialIds: firstKeys.map((row) => row.id), keys }
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
