import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canEditStructure, canManageMembers } from '@school-election/election-core'
import { assertElectionGuard, changeElection, requireElectionAccess } from '../lib/election-access.ts'
import { ELECTION_ACTIONS, ELECTION_ROLES, isPermitted, permissionsOf, type ElectionAction, type ElectionRole } from '../lib/permissions.ts'
import { buildTestApp, ORIGIN, stubDatabase } from './helpers/app.ts'
import { DB, withClient } from './helpers/db.ts'
import { ANNA, auditActions, BERND, CARLA, createElection, electionApp, electionPath, forceElectionState, signIn, WANDA, type Browser } from './helpers/elections.ts'

// Who may do what, read from the requirements rather than from the code:
// the owner everything, a co-admin everything but co-admins, finalizing
// and deleting, a witness reading only.
const MATRIX: Record<ElectionAction, Record<ElectionRole, boolean>> = {
  'view': { owner: true, admin: true, witness: true },
  'view-results': { owner: true, admin: true, witness: true },
  'configure': { owner: true, admin: true, witness: false },
  'prepare': { owner: true, admin: true, witness: false },
  'issue-keys': { owner: true, admin: true, witness: false },
  'run-rounds': { owner: true, admin: true, witness: false },
  'manage-witnesses': { owner: true, admin: true, witness: false },
  'manage-co-admins': { owner: true, admin: false, witness: false },
  'finalize': { owner: true, admin: false, witness: false },
  'delete-election': { owner: true, admin: false, witness: false },
}

test('every role and action is permitted exactly as the matrix says', () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), [...ELECTION_ACTIONS].sort())
  for (const action of ELECTION_ACTIONS) {
    for (const role of ELECTION_ROLES) {
      assert.equal(isPermitted(role, action), MATRIX[action][role], `${role} ${action}`)
    }
  }
  assert.deepEqual(permissionsOf('witness'), ['view', 'view-results'])
  assert.deepEqual(permissionsOf('owner'), [...ELECTION_ACTIONS])
})

test('every /api/elections/:id route starts with requireElectionAccess, no other route can match an election path, and the guard answers 401 and 404 before anything else', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const bernd = await signIn(s, BERND)
  const id = await createElection(anna)

  // Every route is under /api/ with a static segment next, so a route with
  // a parameter or a wildcard there, say /api/:resource/:id, which the
  // router would try for an election path no election route matches, does
  // not exist. (With a build the app also has its start page's route and
  // the static plugin's /*, which serve the page and the build's files and
  // nothing of an election.)
  assert.ok(s.routes.length > 0)
  for (const route of s.routes) {
    assert.match(route.url, /^\/api\/[a-z-]+(\/|$)/, `${String(route.method)} ${route.url}`)
  }
  const guarded = s.routes.filter((route) => route.url.startsWith('/api/elections/'))
  assert.ok(guarded.length > 0)
  for (const route of guarded) {
    const name = `${String(route.method)} ${route.url}`
    assert.doesNotThrow(() => assertElectionGuard(route), name)
    const url = electionPath(route.url, id)
    const method = route.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    const anonymous = await s.app.inject({ method, url, headers: { 'sec-fetch-site': 'same-origin' } })
    assert.equal(anonymous.statusCode, 401, name)
    // Another teacher, with a body the route would accept: still nothing.
    const outsider = await bernd.request(method, url, method === 'POST' ? { email: 'x@schule.example.org', role: 'witness' } : undefined)
    assert.equal(outsider.statusCode, 404, name)
    if (method !== 'HEAD') assert.deepEqual(outsider.json(), { error: 'not_found' }, name)
  }
  assert.deepEqual(await auditActions(anna, id), ['election.created'])
})

test('under a base path, every route and the guard live below it', DB, async (t) => {
  const s = await electionApp(t, { env: { PUBLIC_URL: `${ORIGIN}/wahl` } })
  assert.ok(s.routes.length > 0)
  for (const route of s.routes) {
    assert.match(route.url, /^\/wahl\/api\/[a-z-]+(\/|$)/, `${String(route.method)} ${route.url}`)
    assert.doesNotThrow(() => assertElectionGuard(route, '/wahl'), route.url)
  }
  const anna = await signIn(s, ANNA)
  const created = await anna.request('POST', '/wahl/api/elections', { title: 'Unter einem Pfad' })
  assert.equal(created.statusCode, 201, created.body)
  const id = created.json<{ id: string }>().id
  assert.equal((await anna.request('GET', `/wahl/api/elections/${id}`)).statusCode, 200)
  for (const url of ['/api/elections', `/api/elections/${id}`]) {
    const res = await anna.request('GET', url)
    assert.deepEqual([res.statusCode, res.json()], [404, { error: 'not_found' }], url)
  }
})

test('the app refuses to register an election route without the guard', async (t) => {
  const { app } = await buildTestApp()
  t.after(() => app.close())
  const handler = async () => ({})
  const guard = () => requireElectionAccess(stubDatabase(), 'view')
  assert.throws(() => app.get('/api/elections/:id/leak', handler), /must address the election as :id and start with requireElectionAccess/)
  assert.throws(() => app.get('/api/elections/:id/late', { preHandler: guard() }, handler), /requireElectionAccess/)
  assert.throws(() => app.get('/api/elections/:id/second', { onRequest: [async () => {}, guard()] }, handler), /requireElectionAccess/)
  assert.throws(() => app.get('/api/elections/:electionId', { onRequest: guard() }, handler), /:id/)
  assert.throws(() => app.get('/api/elections/', handler), /:id/)
  assert.throws(() => app.post('/api/elections/', { onRequest: guard() }, handler), /:id/)
  assert.doesNotThrow(() => app.get('/api/elections/:id/fine', { onRequest: guard() }, handler))
  assert.doesNotThrow(() => app.get('/api/elections/:id/also-fine', { onRequest: [guard(), async () => {}] }, handler))
})

test('teacher A can neither read nor change teacher B\'s election, and a guessed id is the same 404', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const bernd = await signIn(s, BERND)
  const annas = await createElection(anna)
  const bernds = await createElection(bernd, 'Klassensprecherwahl 4A')

  for (const id of [annas, '6c1e8b0a-1d2f-4e3a-9b8c-7d6e5f4a3b2c', 'not-an-id', annas.toUpperCase()]) {
    for (const [method, path, body] of [
      ['GET', '', undefined],
      ['GET', '/audit', undefined],
      ['GET', '/members', undefined],
      ['POST', '/members', { email: 'spy@schule.example.org', role: 'admin' }],
    ] as const) {
      const res = await bernd.request(method, `/api/elections/${id}${path}`, body)
      assert.deepEqual([res.statusCode, res.json()], [404, { error: 'not_found' }], `${method} ${id}${path}`)
    }
  }
  const list = (await bernd.request('GET', '/api/elections')).json<{ id: string }[]>()
  assert.deepEqual(list.map((e) => e.id), [bernds])
  assert.deepEqual(await auditActions(anna, annas), ['election.created'])
})

test('a witness reads, but every change is 403 and leaves no event, as is a co-admin inviting a co-admin; without the teacher role nobody creates an election', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  for (const [person, role] of [[WANDA, 'witness'], [CARLA, 'admin']] as const) {
    assert.equal((await anna.request('POST', `/api/elections/${id}/members`, { email: person.email, role })).statusCode, 201)
  }
  const wanda = await signIn(s, WANDA)
  const carla = await signIn(s, CARLA)
  const owner = (await anna.request('GET', `/api/elections/${id}/members`)).json<{ id: string, role: string }[]>().find((m) => m.role === 'owner')
  assert.ok(owner)
  const before = await auditActions(anna, id)

  for (const path of ['', '/audit', '/members']) {
    assert.equal((await wanda.request('GET', `/api/elections/${id}${path}`)).statusCode, 200, path)
  }
  const detail = (await wanda.request('GET', `/api/elections/${id}`)).json<{ role: string, permissions: string[] }>()
  assert.deepEqual([detail.role, detail.permissions], ['witness', ['view', 'view-results']])

  // A witness invites nobody, a co-admin no co-admin.
  for (const [browser, role] of [[wanda, 'witness'], [carla, 'admin']] as const) {
    const invite = await browser.request('POST', `/api/elections/${id}/members`, { email: 'x@schule.example.org', role })
    assert.deepEqual([invite.statusCode, invite.json()], [403, { error: 'forbidden' }])
  }
  const remove = await wanda.request('DELETE', `/api/elections/${id}/members/${owner.id}`)
  assert.deepEqual([remove.statusCode, remove.json()], [403, { error: 'forbidden' }])
  // An invalid body from someone not allowed to send one is still 403: the
  // guard runs before the body is read.
  assert.equal((await wanda.request('POST', `/api/elections/${id}/members`, { nonsense: true })).statusCode, 403)

  const create = await wanda.request('POST', '/api/elections', { title: 'Meine Wahl' })
  assert.deepEqual([create.statusCode, create.json()], [403, { error: 'forbidden' }])
  assert.equal((await s.app.inject({ method: 'POST', url: '/api/elections', headers: { 'sec-fetch-site': 'same-origin' }, payload: { title: 'x' } })).statusCode, 401)
  assert.deepEqual(await auditActions(anna, id), before)
})

test('once final, member changes are 409 with the lifecycle\'s reason, and reading goes on', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  await forceElectionState(s.ownerUrl, id, 'final')
  const res = await anna.request('POST', `/api/elections/${id}/members`, { email: WANDA.email, role: 'witness' })
  assert.deepEqual([res.statusCode, res.json()], [409, { error: 'election_final' }])
  assert.equal((await anna.request('GET', `/api/elections/${id}/members`)).statusCode, 200)
  assert.deepEqual(await auditActions(anna, id), ['election.created'])
})

test('a change checks access again under the election\'s lock: a removal or a state change after the guard stops it', DB, async (t) => {
  const s = await electionApp(t)
  // A route whose guard passes, then something changes before the change runs.
  let meanwhile: () => Promise<unknown> = async () => {}
  s.app.post('/api/elections/:id/test-change', {
    onRequest: requireElectionAccess(s.db, 'manage-witnesses', canManageMembers),
    preHandler: async () => {
      await meanwhile()
    },
  }, async (request) => changeElection(s.db, request, async (client, access) => {
    await client.query('select 1')
    return { role: access.role }
  }))
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const post = (browser: Browser) => browser.request('POST', `/api/elections/${id}/test-change`, {})
  assert.deepEqual((await post(anna)).json(), { role: 'owner' })

  meanwhile = () => forceElectionState(s.ownerUrl, id, 'final')
  const final = await post(anna)
  assert.deepEqual([final.statusCode, final.json()], [409, { error: 'election_final' }])

  meanwhile = () => withClient(s.ownerUrl, (client) => client.query('delete from election_member where election_id = $1', [id]))
  await forceElectionState(s.ownerUrl, id, 'draft')
  const removed = await post(anna)
  assert.deepEqual([removed.statusCode, removed.json()], [404, { error: 'not_found' }])
})

test('two changes of one election run one after the other: the second waits for the first to commit and sees its lifecycle', DB, async (t) => {
  const s = await electionApp(t)
  // The first change moves the election on and holds the election's lock until released; the second needs a draft.
  let entered = () => {}
  let release = () => {}
  const inside = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  t.after(() => release())
  const guard = () => requireElectionAccess(s.db, 'configure', canEditStructure)
  s.app.post('/api/elections/:id/test-prepare', { onRequest: guard() }, async (request) => changeElection(s.db, request, async (client, access) => {
    await client.query(`update election set state = 'prepared' where id = $1`, [access.electionId])
    entered()
    await held
    return { was: access.lifecycle.election }
  }))
  s.app.post('/api/elections/:id/test-structure', { onRequest: guard() }, async (request) => changeElection(s.db, request, async (_client, access) => ({ was: access.lifecycle.election })))
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)

  const first = anna.request('POST', `/api/elections/${id}/test-prepare`, {})
  await inside
  // The second passes its guard, since the first has not committed, and then waits for the lock.
  const second = anna.request('POST', `/api/elections/${id}/test-structure`, {})
  for (let waited = 0; ; waited++) {
    const { rows: [lock] } = await s.db.query<{ n: number }>(`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`)
    if (lock?.n === 1) break
    assert.ok(waited < 400, 'the second change waits for the first')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  release()
  assert.deepEqual((await first).json(), { was: 'draft' })
  const res = await second
  assert.deepEqual([res.statusCode, res.json()], [409, { error: 'not_draft' }])
})
