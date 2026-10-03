// Keys and their batches (lib/credentials.ts), on the app's own database
// connection: issuing, topping up and replacing, who reads which keys, and
// preparing again after a return to draft. The batch routes and the print
// page build on these operations.

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { LightMyRequestResponse } from 'fastify'
import { parseKey, type ElectionState, type RoundKind, type RoundState } from '@school-election/election-core'
import type pg from 'pg'
import { lockElection } from '../lib/audit.ts'
import { issueBatch, listBatches, readBatchKeys, replaceBatch, type BatchKeys } from '../lib/credentials.ts'
import { lifecycleOf, Refusal, ROUND_STATES_SQL, type ElectionAccess } from '../lib/election-access.ts'
import { prepareElection, type PrepareResult } from '../lib/prepare.ts'
import type { ElectionRole } from '../lib/permissions.ts'
import { DB, withClient } from './helpers/db.ts'
import { ANNA, CARLA, createElection, electionApp, forceElectionState, forceRoundState, signIn, WANDA, type Browser, type ElectionApp, type Person } from './helpers/elections.ts'

interface Setup {
  s: ElectionApp
  anna: Browser
  wanda: Browser
  id: string
  school: string
  klasse: string
  g1a: string
  g2b: string
  /** The library's operations as the member, holding the election's lock, as a route's change does. */
  issue: (person: Person, voterGroupId: string, roundKind: RoundKind, count: number) => Promise<BatchKeys>
  replace: (person: Person, batchId: string) => Promise<BatchKeys>
  read: (person: Person, batchId: string) => Promise<BatchKeys>
  prepare: (person: Person) => Promise<PrepareResult>
}

const ok = <T>(res: LightMyRequestResponse, status = 200): T => {
  assert.equal(res.statusCode, status, res.body)
  return res.json<T>()
}

/**
 * A prepared election with a school and a class contest, class 1A voting in
 * both and 2B in the school contest only, Carla as co-admin and Wanda as
 * witness.
 */
async function prepared(t: TestContext): Promise<Setup> {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const base = `/api/elections/${id}`
  const contest = async (title: string, rulesetId: string, ...surnames: string[]) => {
    const created = ok<{ id: string }>(await anna.request('POST', `${base}/contests`, { title, rulesetId }), 201)
    for (const surname of surnames) ok(await anna.request('POST', `${base}/contests/${created.id}/candidates`, { surname, givenName: 'Test' }), 201)
    return created.id
  }
  const group = async (name: string, contestIds: string[]) => {
    const created = ok<{ id: string }>(await anna.request('POST', `${base}/voter-groups`, { name }), 201)
    ok(await anna.request('PUT', `${base}/voter-groups/${created.id}/contests`, { contestIds }))
    return created.id
  }
  const school = await contest('Schulsprecher/in', 'at-school-speaker-v1', 'Berger', 'Huber', 'Wagner')
  const klasse = await contest('Klassensprecher/in 1A', 'at-representative-v1', 'Fuchs', 'Bauer')
  const g1a = await group('1A', [school, klasse])
  const g2b = await group('2B', [school])
  for (const [person, role] of [[CARLA, 'admin'], [WANDA, 'witness']] as const) {
    ok(await anna.request('POST', `${base}/members`, { email: person.email, role }), 201)
  }
  await signIn(s, CARLA)
  const wanda = await signIn(s, WANDA)
  ok(await anna.request('POST', `${base}/prepare`))
  const as = <T>(person: Person, fn: (client: pg.ClientBase, access: ElectionAccess) => Promise<T>) => s.db.tx(async (client) => {
    await lockElection(client, id)
    return fn(client, await accessOf(s, id, person))
  })
  return {
    s, anna, wanda, id, school, klasse, g1a, g2b,
    issue: (person, voterGroupId, roundKind, count) => as(person, (client, access) => issueBatch(client, access, { voterGroupId, roundKind, count })),
    replace: (person, batchId) => as(person, (client, access) => replaceBatch(client, access, batchId)),
    read: (person, batchId) => as(person, (client, access) => readBatchKeys(client, access, batchId)),
    prepare: (person) => as(person, (client, access) => prepareElection(client, access)),
  }
}

/** What the guard would establish for the person, from the database as it is. */
async function accessOf(s: ElectionApp, electionId: string, person: Person): Promise<ElectionAccess> {
  return withClient(s.ownerUrl, async (client) => {
    const { rows: [row] } = await client.query<{ role: ElectionRole, state: ElectionState, regular: RoundState | null, runoff: RoundState | null, tid: string, oid: string, display_name: string }>(
      `select m.role, e.state, u.tid, u.oid, u.display_name, ${ROUND_STATES_SQL}
         from election_member m join election e on e.id = m.election_id join app_user u on u.id = m.user_id
        where m.election_id = $1 and u.oid = $2`,
      [electionId, person.oid],
    )
    assert.ok(row, person.name)
    return { electionId, role: row.role, lifecycle: lifecycleOf(row.state, row), actor: { tid: row.tid, oid: row.oid, name: row.display_name } }
  })
}

const refusedWith = (statusCode: number, code: string) => (err: unknown) => err instanceof Refusal && err.statusCode === statusCode && err.code === code

/** The stored keys of a batch, in key order, as the database owner reads them. */
async function storedKeys(s: ElectionApp, batchId: string): Promise<string[]> {
  return withClient(s.ownerUrl, async (client) => (await client.query<{ key: string }>('select key from credential where batch_id = $1 order by key collate "C"', [batchId])).rows.map((row) => row.key))
}

/** Each key of a batch with the contests and round kind it is entitled to, as "KEY round:contest,contest". */
async function entitlements(s: ElectionApp, batchId: string): Promise<Map<string, string[]>> {
  return withClient(s.ownerUrl, async (client) => {
    const { rows } = await client.query<{ key: string, contests: string[] | null }>(
      `select c.key, array_agg(r.kind || ':' || rc.contest_id order by rc.contest_id) filter (where rc.id is not null) as contests
         from credential c
         left join credential_entitlement e on e.credential_id = c.id
         left join round_contest rc on rc.id = e.round_contest_id
         left join round r on r.id = rc.round_id
        where c.batch_id = $1 group by c.key`,
      [batchId],
    )
    return new Map(rows.map((row) => [row.key, row.contests ?? []]))
  })
}

const keysOf = (issued: BatchKeys) => issued.keys.map((entry) => entry.key)

test('a batch stores every key exactly as issued, entitled to its group\'s contests; a runoff batch is entitled to nothing, and a top-up leaves the others alone', DB, async (t) => {
  const { s, anna, wanda, id, school, klasse, g1a, g2b, issue } = await prepared(t)
  const regular = await issue(ANNA, g1a, 'regular', 30)
  assert.equal(regular.keys.length, 30)
  assert.equal(new Set(keysOf(regular)).size, 30)
  for (const { key, used } of regular.keys) {
    assert.deepEqual(parseKey(key), { ok: true, key })
    assert.equal(used, null)
  }
  // What the database holds is exactly what was handed out for printing.
  assert.deepEqual(await storedKeys(s, regular.batch.id), keysOf(regular))
  const entitled = await entitlements(s, regular.batch.id)
  assert.deepEqual([...entitled.values()], Array.from({ length: 30 }, () => [`regular:${school}`, `regular:${klasse}`].sort()))

  const runoff = await issue(CARLA, g1a, 'runoff', 5)
  assert.deepEqual([...(await entitlements(s, runoff.batch.id)).values()], Array.from({ length: 5 }, () => []))
  const before = await entitlements(s, regular.batch.id)
  const topUp = await issue(ANNA, g1a, 'regular', 3)
  const other = await issue(ANNA, g2b, 'regular', 2)
  assert.deepEqual(await entitlements(s, regular.batch.id), before)
  assert.deepEqual([...(await entitlements(s, topUp.batch.id)).values()], Array.from({ length: 3 }, () => [`regular:${school}`, `regular:${klasse}`].sort()))
  assert.deepEqual([...(await entitlements(s, other.batch.id)).values()], [[`regular:${school}`], [`regular:${school}`]])
  const all = [regular, runoff, topUp, other].flatMap(keysOf)
  assert.equal(new Set(all).size, 40)

  assert.deepEqual(
    (await listBatches(s.db, id)).map((batch) => [batch.voterGroupId, batch.roundKind, batch.state, batch.keys]).toSorted(),
    [[g1a, 'regular', 'issued', 30], [g1a, 'regular', 'issued', 3], [g1a, 'runoff', 'issued', 5], [g2b, 'regular', 'issued', 2]].toSorted(),
  )

  // Each issue is recorded with its counts, and no key reaches the audit
  // log, a log line or any response of the routes there are.
  const events = ok<{ events: { action: string, metadata: Record<string, unknown> }[] }>(await anna.request('GET', `/api/elections/${id}/audit`)).events
  assert.deepEqual(events.filter((e) => e.action === 'credential-batch.issued').map((e) => e.metadata), [
    { batch: regular.batch.id, group: g1a, round: 'regular', keys: 30 },
    { batch: runoff.batch.id, group: g1a, round: 'runoff', keys: 5 },
    { batch: topUp.batch.id, group: g1a, round: 'regular', keys: 3 },
    { batch: other.batch.id, group: g2b, round: 'regular', keys: 2 },
  ])
  const responses: string[] = []
  for (const route of s.routes.filter((r) => [r.method].flat().includes('GET') && r.url.startsWith('/api/'))) {
    const url = route.url.replace(':id', id).replace(':sha256', 'a'.repeat(64)).replaceAll(/:[a-zA-Z]+Id\b/g, school)
    for (const browser of [anna, wanda]) {
      const res = await browser.request('GET', url)
      responses.push(`${res.statusCode} ${res.body}`)
    }
  }
  // The election, its configuration, preparation, members and audit log, for both.
  assert.ok(responses.filter((response) => response.startsWith('200 ')).length >= 10)
  const seen = [...responses, s.logs()].join('\n')
  assert.deepEqual(all.filter((key) => seen.includes(key)), [])
})

test('the owner and co-admins read a batch\'s keys whenever they like; a witness only once its round has closed, each key used or unused', DB, async (t) => {
  const { s, id, g1a, issue, read } = await prepared(t)
  const issued = await issue(ANNA, g1a, 'regular', 4)
  const runoff = await issue(ANNA, g1a, 'runoff', 2)
  const count = () => withClient(s.ownerUrl, async (client) => (await client.query<{ n: number }>('select count(*)::int as n from credential')).rows[0]?.n)
  // Reading, as often as anyone likes, shows the stored keys and never creates any.
  for (const person of [ANNA, CARLA, ANNA]) {
    assert.deepEqual(await read(person, issued.batch.id), issued)
  }
  assert.equal(await count(), 6)
  await assert.rejects(read(WANDA, issued.batch.id), refusedWith(403, 'forbidden'))
  await assert.rejects(read(ANNA, '0d3b5a0e-6a43-4c1b-9f5e-3d2c1b0a9f8e'), refusedWith(404, 'not_found'))

  // Voting with one key while the round is open; nobody learns which yet.
  const [usedKey, ...unused] = keysOf(issued)
  await forceElectionState(s.ownerUrl, id, 'active')
  await withClient(s.ownerUrl, (client) => client.query(
    `update credential_entitlement e set consumed = true from credential c where c.id = e.credential_id and c.key = $1`,
    [usedKey],
  ))
  await assert.rejects(read(WANDA, issued.batch.id), refusedWith(403, 'forbidden'))
  assert.deepEqual((await read(ANNA, issued.batch.id)).keys.map((k) => k.used), [null, null, null, null])

  // Closed: the witness sees every key of the round, used or unused; the
  // runoff keys, which could still vote, stay hidden from them.
  await forceRoundState(s.ownerUrl, id, 'closed')
  const expected = keysOf(issued).map((key) => ({ key, used: key === usedKey }))
  for (const person of [WANDA, ANNA]) {
    assert.deepEqual((await read(person, issued.batch.id)).keys, expected)
  }
  assert.equal(unused.length, 3)
  await assert.rejects(read(WANDA, runoff.batch.id), refusedWith(403, 'forbidden'))
  assert.equal(await count(), 6)
})

test('replacing a batch voids its keys and issues as many new ones, only until its round opens; issuing waits for preparing and is for owner and co-admins', DB, async (t) => {
  const { s, anna, id, school, klasse, g1a, issue, replace } = await prepared(t)
  const issued = await issue(ANNA, g1a, 'regular', 5)
  const replacement = await replace(CARLA, issued.batch.id)
  assert.equal(replacement.keys.length, 5)
  assert.deepEqual(keysOf(replacement).filter((key) => keysOf(issued).includes(key)), [])
  assert.deepEqual(await storedKeys(s, replacement.batch.id), keysOf(replacement))
  // The old keys stay stored, void, so their sheets can still be compared.
  assert.deepEqual(await storedKeys(s, issued.batch.id), keysOf(issued))
  assert.deepEqual((await listBatches(s.db, id)).map((b) => [b.id, b.state]).toSorted(), [[issued.batch.id, 'void'], [replacement.batch.id, 'issued']].toSorted())
  assert.deepEqual([...(await entitlements(s, replacement.batch.id)).values()], Array.from({ length: 5 }, () => [`regular:${school}`, `regular:${klasse}`].sort()))
  await assert.rejects(replace(ANNA, issued.batch.id), refusedWith(409, 'batch_void'))
  const events = ok<{ events: { action: string, metadata: Record<string, unknown> }[] }>(await anna.request('GET', `/api/elections/${id}/audit`)).events
  assert.deepEqual(events.filter((e) => e.action === 'credential-batch.replaced').map((e) => e.metadata), [
    { batch: issued.batch.id, replacement: replacement.batch.id, group: g1a, round: 'regular', keys: 5 },
  ])

  await assert.rejects(issue(WANDA, g1a, 'regular', 1), refusedWith(403, 'forbidden'))
  await assert.rejects(replace(WANDA, replacement.batch.id), refusedWith(403, 'forbidden'))
  await assert.rejects(issue(ANNA, '0d3b5a0e-6a43-4c1b-9f5e-3d2c1b0a9f8e', 'regular', 1), refusedWith(404, 'not_found'))
  await assert.rejects(issue(ANNA, g1a, 'regular', 0), RangeError)

  // Once voting has started, regular keys are fixed; runoff keys can still be issued and replaced.
  await forceElectionState(s.ownerUrl, id, 'active')
  await assert.rejects(issue(ANNA, g1a, 'regular', 1), refusedWith(409, 'voting_started'))
  await assert.rejects(replace(ANNA, replacement.batch.id), refusedWith(409, 'voting_started'))
  const runoff = await issue(ANNA, g1a, 'runoff', 2)
  const runoffReplacement = await replace(ANNA, runoff.batch.id)
  assert.equal(runoffReplacement.keys.length, 2)

  // A draft has no keys to issue.
  await forceElectionState(s.ownerUrl, id, 'draft')
  await forceRoundState(s.ownerUrl, id, 'planned')
  await assert.rejects(issue(ANNA, g1a, 'regular', 1), refusedWith(409, 'not_prepared'))
})

test('preparing again voids only the unused batches of groups whose contests changed, and only once confirmed; candidate corrections and removed contests leave keys valid', DB, async (t) => {
  const { s, anna, id, school, klasse, g1a, g2b, issue } = await prepared(t)
  const base = `/api/elections/${id}`
  const batch1a = await issue(ANNA, g1a, 'regular', 3)
  const batch2b = await issue(ANNA, g2b, 'regular', 2)
  const runoff2b = await issue(ANNA, g2b, 'runoff', 2)
  const before1a = await entitlements(s, batch1a.batch.id)

  // A candidate correction while prepared touches no key.
  const configuration = ok<{ contests: { id: string, candidates: { id: string, surname: string }[] }[] }>(await anna.request('GET', `${base}/configuration`))
  const berger = configuration.contests.find((c) => c.id === school)?.candidates.find((c) => c.surname === 'Berger')
  assert.ok(berger)
  ok(await anna.request('PATCH', `${base}/candidates/${berger.id}`, { surname: 'Bergér' }))
  assert.deepEqual(await entitlements(s, batch1a.batch.id), before1a)

  // Back to draft: 2B now votes in the class contest too, 1A is unchanged.
  ok(await anna.request('POST', `${base}/unprepare`))
  ok(await anna.request('PUT', `${base}/voter-groups/${g2b}/contests`, { contestIds: [school, klasse] }))
  const refusal = await anna.request('POST', `${base}/prepare`)
  assert.equal(refusal.statusCode, 409)
  assert.deepEqual(refusal.json(), { error: 'void_required', batches: [{ id: batch2b.batch.id, voterGroupId: g2b, keys: 2 }] })
  assert.equal(ok<{ state: string }>(await anna.request('GET', base)).state, 'draft')
  assert.equal(ok<{ error: string }>(await anna.request('POST', `${base}/prepare`, { confirmVoid: false }), 409).error, 'void_required')

  ok(await anna.request('POST', `${base}/prepare`, { confirmVoid: true }))
  assert.deepEqual(
    (await listBatches(s.db, id)).map((b) => [b.id, b.state]).toSorted(),
    [[batch1a.batch.id, 'issued'], [batch2b.batch.id, 'void'], [runoff2b.batch.id, 'issued']].toSorted(),
  )
  assert.deepEqual(await entitlements(s, batch1a.batch.id), before1a)
  const events = ok<{ events: { action: string, metadata: Record<string, unknown> }[] }>(await anna.request('GET', `${base}/audit`)).events
  assert.deepEqual(events.slice(-2).map((e) => [e.action, e.metadata]), [
    ['credential-batch.voided', { batch: batch2b.batch.id, group: g2b, keys: 2 }],
    ['election.prepared', { contests: 2, voterGroups: 2, candidates: 5 }],
  ])

  // A contest removed in a draft takes its entitlements along: 1A's keys
  // still fit what 1A votes in, and preparing again keeps them.
  ok(await anna.request('POST', `${base}/unprepare`))
  assert.equal((await anna.request('DELETE', `${base}/contests/${klasse}`)).statusCode, 204)
  ok(await anna.request('POST', `${base}/prepare`))
  assert.deepEqual([...(await entitlements(s, batch1a.batch.id)).values()], [[`regular:${school}`], [`regular:${school}`], [`regular:${school}`]])
  assert.equal((await listBatches(s.db, id)).find((b) => b.id === batch1a.batch.id)?.state, 'issued')
})

test('preparing waits for a structure change that has not committed yet, and sees it', DB, async (t) => {
  const { s, anna, id, klasse, g2b, issue, prepare } = await prepared(t)
  const batch = await issue(ANNA, g2b, 'regular', 2)
  ok(await anna.request('POST', `/api/elections/${id}/unprepare`))
  // 2B gains the class contest in a transaction that is still open while
  // preparing starts; one that did not come through the API's lock.
  let preparing: Promise<PrepareResult> | undefined
  await s.db.tx(async (client) => {
    await client.query('insert into voter_group_contest (election_id, voter_group_id, contest_id) values ($1, $2, $3)', [id, g2b, klasse])
    preparing = prepare(ANNA)
    await withClient(s.ownerUrl, async (owner) => {
      for (let waited = 0; ; waited += 20) {
        const { rows } = await owner.query(`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)
        if (rows.length > 0) return
        if (waited > 5000) throw new Error('preparing never waited for the open change')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    })
  })
  assert.deepEqual(await preparing, { prepared: false, problems: [], staleBatches: [{ id: batch.batch.id, voterGroupId: g2b, keys: 2 }] })
})
