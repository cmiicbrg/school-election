import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canManageMembers } from '@school-election/election-core'
import { assertElectionGuard, changeElection, requireElectionAccess } from '../lib/election-access.ts'
import { ELECTION_ACTIONS, ELECTION_ROLES, isPermitted, permissionsOf, type ElectionAction, type ElectionRole } from '../lib/permissions.ts'
import { buildTestApp, stubDatabase } from './helpers/app.ts'
import { DB, withClient } from './helpers/db.ts'
import { ANNA, auditActions, BERND, CARLA, createElection, electionApp, electionPath, forceElectionState, signIn, WANDA, type Browser } from './helpers/elections.ts'

// Who may do what, read from the requirements rather than from the code:
// the owner everything, a co-admin everything but members and finalizing,
// a witness reading only.
const MATRIX: Record<ElectionAction, Record<ElectionRole, boolean>> = {
  'view': { owner: true, admin: true, witness: true },
  'view-results': { owner: true, admin: true, witness: true },
  'configure': { owner: true, admin: true, witness: false },
  'prepare': { owner: true, admin: true, witness: false },
  'issue-keys': { owner: true, admin: true, witness: false },
  'run-rounds': { owner: true, admin: true, witness: false },
  'enter-lot': { owner: true, admin: true, witness: false },
  'manage-members': { owner: true, admin: false, witness: false },
  'finalize': { owner: true, admin: false, witness: false },
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

const ELECTION_ROUTES = [
  'DELETE /api/elections/:id/candidates/:candidateId',
  'DELETE /api/elections/:id/candidates/:candidateId/picture',
  'DELETE /api/elections/:id/contests/:contestId',
  'DELETE /api/elections/:id/members/:memberId',
  'DELETE /api/elections/:id/voter-groups/:groupId',
  'GET /api/elections',
  'GET /api/elections/:id',
  'GET /api/elections/:id/audit',
  'GET /api/elections/:id/candidates/:candidateId/picture/:sha256',
  'GET /api/elections/:id/configuration',
  'GET /api/elections/:id/members',
  'GET /api/elections/:id/preparation',
  'HEAD /api/elections',
  'HEAD /api/elections/:id',
  'HEAD /api/elections/:id/audit',
  'HEAD /api/elections/:id/candidates/:candidateId/picture/:sha256',
  'HEAD /api/elections/:id/configuration',
  'HEAD /api/elections/:id/members',
  'HEAD /api/elections/:id/preparation',
  'PATCH /api/elections/:id',
  'PATCH /api/elections/:id/candidates/:candidateId',
  'PATCH /api/elections/:id/contests/:contestId',
  'PATCH /api/elections/:id/voter-groups/:groupId',
  'POST /api/elections',
  'POST /api/elections/:id/contests',
  'POST /api/elections/:id/contests/:contestId/candidates',
  'POST /api/elections/:id/members',
  'POST /api/elections/:id/prepare',
  'POST /api/elections/:id/unprepare',
  'POST /api/elections/:id/voter-groups',
  'PUT /api/elections/:id/candidates/:candidateId/picture',
  'PUT /api/elections/:id/voter-groups/:groupId/contests',
]

test('every /api/elections/:id route starts with requireElectionAccess, and answers 401 and 404 before anything else', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const bernd = await signIn(s, BERND)
  const id = await createElection(anna)

  const routes = s.routes.filter((route) => route.url.startsWith('/api/elections'))
  const listed = routes.map((route) => `${String(route.method)} ${route.url}`).sort()
  assert.deepEqual(listed, ELECTION_ROUTES, 'a new election route needs a look at its guard, and an entry here')
  const guarded = routes.filter((route) => route.url.startsWith('/api/elections/'))
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

test('a route that matches election paths through a parameter or a wildcard does not serve them', DB, async (t) => {
  const s = await electionApp(t)
  // Registered without complaint: its pattern does not start with /api/elections/.
  s.app.get('/api/:resource/:id/leak', async (request) => ({ leaked: request.params }))
  s.app.post('/api/:resource/*', async () => ({ leaked: true }))
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  for (const [method, url] of [
    ['GET', `/api/elections/${id}/leak`],
    ['GET', `/api/%65lections/${id}/leak`],
    ['HEAD', `/api/elections/${id}/leak`],
    ['POST', `/api/elections/${id}/anything`],
  ] as const) {
    const res = await anna.request(method, url, method === 'POST' ? {} : undefined)
    assert.equal(res.statusCode, 404, `${method} ${url}`)
    if (method !== 'HEAD') assert.deepEqual(res.json(), { error: 'not_found' }, `${method} ${url}`)
  }
  // Elsewhere such a route works as before, and the guarded routes still answer.
  assert.equal((await anna.request('GET', `/api/other/${id}/leak`)).statusCode, 200)
  assert.equal((await anna.request('GET', `/api/elections/${id}`)).statusCode, 200)
  assert.equal((await anna.request('GET', `/api/%65lections/${id}`)).statusCode, 200)
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

test('a witness reads, but every change is 403 and leaves no event; without the teacher role nobody creates an election', DB, async (t) => {
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

  for (const browser of [wanda, carla]) {
    const invite = await browser.request('POST', `/api/elections/${id}/members`, { email: 'x@schule.example.org', role: 'witness' })
    assert.deepEqual([invite.statusCode, invite.json()], [403, { error: 'forbidden' }])
    const remove = await browser.request('DELETE', `/api/elections/${id}/members/${owner.id}`)
    assert.deepEqual([remove.statusCode, remove.json()], [403, { error: 'forbidden' }])
  }
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
    onRequest: requireElectionAccess(s.db, 'manage-members', canManageMembers),
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
