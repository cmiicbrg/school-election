import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyAuditChain, type AuditEvent } from '../lib/audit-chain.ts'
import { bindInvitations } from '../lib/members.ts'
import { DB, withClient } from './helpers/db.ts'
import { TENANT_ID } from './helpers/env.ts'
import { ANNA, auditActions, BERND, CARLA, createElection, electionApp, forceElectionState, signIn, WANDA, type Browser } from './helpers/elections.ts'

interface MemberView {
  id: string
  role: string
  status: string
  email: string | null
  displayName: string | null
}

async function members(browser: Browser, id: string): Promise<MemberView[]> {
  const res = await browser.request('GET', `/api/elections/${id}/members`)
  assert.equal(res.statusCode, 200)
  return res.json<MemberView[]>()
}

async function auditLog(browser: Browser, id: string): Promise<{ events: AuditEvent[], chain: unknown }> {
  const res = await browser.request('GET', `/api/elections/${id}/audit`)
  assert.equal(res.statusCode, 200)
  return res.json()
}

const invite = (owner: Browser, id: string, email: string | undefined, role: 'admin' | 'witness' = 'witness') =>
  owner.request('POST', `/api/elections/${id}/members`, { email, role })

test('create, invite, bind and remove: each change is audited in one chain that verifies', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const created = await anna.request('POST', '/api/elections', { title: 'Schulsprecherwahl 2026/27', description: 'Wahl am 5. Oktober\nim Festsaal' })
  assert.equal(created.statusCode, 201)
  const election = created.json<{ id: string, title: string, description: string, state: string, role: string, permissions: string[] }>()
  assert.match(election.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.deepEqual({ ...election, id: undefined, permissions: undefined, lifecycle: undefined }, {
    id: undefined,
    lifecycle: undefined,
    title: 'Schulsprecherwahl 2026/27',
    description: 'Wahl am 5. Oktober\nim Festsaal',
    state: 'draft',
    role: 'owner',
    permissions: undefined,
  })
  assert.ok(election.permissions.includes('manage-witnesses') && election.permissions.includes('manage-co-admins'))
  const id = election.id

  // Invited with the address as the owner typed it; Wanda's token has it in lowercase.
  const invited = await invite(anna, id, 'Wanda.Zeugin@Schule.Example.org')
  assert.equal(invited.statusCode, 201)
  const pending = invited.json<MemberView>()
  assert.deepEqual({ ...pending, id: undefined }, { id: undefined, role: 'witness', status: 'pending', email: 'Wanda.Zeugin@Schule.Example.org', displayName: null })

  const wanda = await signIn(s, WANDA)
  assert.deepEqual((await wanda.request('GET', '/api/elections')).json(), [{ id, title: 'Schulsprecherwahl 2026/27', state: 'draft', role: 'witness' }])
  assert.deepEqual(await members(anna, id), [
    { id: (await members(anna, id))[0]?.id, role: 'owner', status: 'bound', email: null, displayName: 'Anna Lehrerin' },
    { id: pending.id, role: 'witness', status: 'bound', email: 'Wanda.Zeugin@Schule.Example.org', displayName: 'Wanda Zeugin' },
  ])

  const removed = await anna.request('DELETE', `/api/elections/${id}/members/${pending.id}`)
  assert.equal(removed.statusCode, 204)

  const { events, chain } = await auditLog(anna, id)
  assert.deepEqual(chain, { valid: true, length: 4, head: events[3]?.hash })
  assert.deepEqual(verifyAuditChain(events), chain)
  assert.deepEqual(events.map((e) => [e.action, e.actor.oid, e.actor.name, e.metadata]), [
    ['election.created', ANNA.oid, 'Anna Lehrerin', { title: 'Schulsprecherwahl 2026/27' }],
    ['member.invited', ANNA.oid, 'Anna Lehrerin', { email: 'Wanda.Zeugin@Schule.Example.org', role: 'witness' }],
    // The binding names the person it was bound to: Wanda, at her sign-in.
    ['member.bound', WANDA.oid, 'Wanda Zeugin', { email: 'Wanda.Zeugin@Schule.Example.org', role: 'witness' }],
    ['member.removed', ANNA.oid, 'Anna Lehrerin', { email: 'Wanda.Zeugin@Schule.Example.org', role: 'witness' }],
  ])
  assert.ok(events.every((e) => e.actor.tid === TENANT_ID && e.electionId === id))
})

test('an invitation binds once, to the first person signing in with the address, and never moves', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  assert.equal((await invite(anna, id, WANDA.email)).statusCode, 201)
  await signIn(s, WANDA)
  await signIn(s, WANDA)
  // The address passed on to someone else later: a new person, a new oid.
  const successor = await signIn(s, { oid: 'e0000000-0000-4000-8000-00000000000e', name: 'Neue Besitzerin', email: WANDA.email })
  assert.deepEqual((await successor.request('GET', '/api/elections')).json(), [])
  assert.equal((await successor.request('GET', `/api/elections/${id}`)).statusCode, 404)
  assert.deepEqual(await auditActions(anna, id), ['election.created', 'member.invited', 'member.bound'])
  assert.deepEqual((await members(anna, id)).map((m) => m.displayName), ['Anna Lehrerin', 'Wanda Zeugin'])
})

test('without an email claim the preferred username is matched; another address matches nothing', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  assert.equal((await invite(anna, id, 'carla.kollegin@schule.example.org', 'admin')).statusCode, 201)
  const other = await signIn(s, { ...BERND, email: 'carla.kollegin@other.example.org' })
  assert.equal((await other.request('GET', `/api/elections/${id}`)).statusCode, 404)
  const carla = await signIn(s, { ...CARLA, email: undefined, preferredUsername: 'Carla.Kollegin@schule.example.org' })
  const detail = (await carla.request('GET', `/api/elections/${id}`)).json<{ role: string, permissions: string[] }>()
  assert.equal(detail.role, 'admin')
  assert.ok(detail.permissions.includes('manage-witnesses') && !detail.permissions.includes('manage-co-admins') && !detail.permissions.includes('finalize'))
})

test('a pending invitation grants nothing: someone already signed in gets access with their next sign-in', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const early = await signIn(s, WANDA)
  const id = await createElection(anna)
  assert.equal((await invite(anna, id, WANDA.email)).statusCode, 201)
  assert.equal((await early.request('GET', `/api/elections/${id}`)).statusCode, 404)
  assert.deepEqual((await early.request('GET', '/api/elections')).json(), [])
  const again = await signIn(s, WANDA)
  assert.equal((await again.request('GET', `/api/elections/${id}`)).statusCode, 200)
  // The session from before the binding is the same person, so it sees the election now too.
  assert.equal((await early.request('GET', `/api/elections/${id}`)).statusCode, 200)
})

test('removal takes effect with the removed member\'s next request', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const member = (await invite(anna, id, CARLA.email, 'admin')).json<MemberView>()
  const carla = await signIn(s, CARLA)
  assert.equal((await carla.request('GET', `/api/elections/${id}/audit`)).statusCode, 200)
  assert.equal((await anna.request('DELETE', `/api/elections/${id}/members/${member.id}`)).statusCode, 204)
  for (const path of ['', '/audit', '/members']) {
    assert.equal((await carla.request('GET', `/api/elections/${id}${path}`)).statusCode, 404, path)
  }
  assert.deepEqual((await carla.request('GET', '/api/elections')).json(), [])
  // Invited again, she is pending again until she signs in again.
  assert.equal((await invite(anna, id, CARLA.email, 'witness')).statusCode, 201)
  assert.equal((await carla.request('GET', `/api/elections/${id}`)).statusCode, 404)
})

test('a co-admin invites and removes witnesses, but co-admins only the owner', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  assert.equal((await invite(anna, id, CARLA.email, 'admin')).statusCode, 201)
  const bernd = (await invite(anna, id, BERND.email, 'admin')).json<MemberView>()
  const carla = await signIn(s, CARLA)
  const before = await auditActions(anna, id)

  const wanda = await invite(carla, id, WANDA.email, 'witness')
  assert.equal(wanda.statusCode, 201)
  const coAdmin = await invite(carla, id, 'dora.kollegin@schule.example.org', 'admin')
  assert.deepEqual([coAdmin.statusCode, coAdmin.json()], [403, { error: 'forbidden' }])
  const removeCoAdmin = await carla.request('DELETE', `/api/elections/${id}/members/${bernd.id}`)
  assert.deepEqual([removeCoAdmin.statusCode, removeCoAdmin.json()], [403, { error: 'forbidden' }])
  assert.equal((await carla.request('DELETE', `/api/elections/${id}/members/${wanda.json<MemberView>().id}`)).statusCode, 204)

  assert.deepEqual(await auditActions(anna, id), [...before, 'member.invited', 'member.removed'])
  assert.deepEqual((await members(anna, id)).map((member) => member.role), ['owner', 'admin', 'admin'])
})

test('refused member changes: a second invitation, the owner, an unknown member, a bad address; none leaves an event', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const bernd = await signIn(s, BERND)
  const id = await createElection(anna)
  const other = await createElection(bernd, 'Andere Wahl')
  assert.equal((await invite(anna, id, WANDA.email)).statusCode, 201)
  const before = await auditActions(anna, id)

  for (const [email, role] of [['WANDA.ZEUGIN@schule.example.org', 'admin'], [ANNA.email, 'witness']] as const) {
    const res = await invite(anna, id, email, role)
    assert.deepEqual([res.statusCode, res.json()], [409, { error: 'already_member' }], String(email))
  }
  const owner = (await members(anna, id)).find((m) => m.role === 'owner')
  const removeOwner = await anna.request('DELETE', `/api/elections/${id}/members/${owner?.id}`)
  assert.deepEqual([removeOwner.statusCode, removeOwner.json()], [409, { error: 'owner_not_removable' }])
  const othersOwner = (await members(bernd, other))[0]
  for (const memberId of [othersOwner?.id, '0d3b5a0e-6a43-4c1b-9f5e-3d2c1b0a9f8e']) {
    const res = await anna.request('DELETE', `/api/elections/${id}/members/${memberId}`)
    assert.deepEqual([res.statusCode, res.json()], [404, { error: 'not_found' }])
  }
  assert.equal((await anna.request('DELETE', `/api/elections/${id}/members/not-an-id`)).statusCode, 400)
  for (const body of [
    { email: 'no-at-sign', role: 'witness' },
    { email: 'two@at@schule.example.org', role: 'witness' },
    { email: ' padded@schule.example.org', role: 'witness' },
    { email: 'x@schule.example.org', role: 'owner' },
    { email: 'x@schule.example.org', role: 'witness', extra: 1 },
    { email: 'x\u0000@schule.example.org', role: 'witness' },
  ]) {
    const res = await anna.request('POST', `/api/elections/${id}/members`, body)
    assert.equal(res.statusCode, 400, JSON.stringify(body))
  }
  assert.deepEqual(await auditActions(anna, id), before)
  assert.deepEqual(await auditActions(bernd, other), ['election.created'])
})

test('election titles are one line of text; descriptions may span lines', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  for (const body of [{}, { title: '' }, { title: '   ' }, { title: 'a\nb' }, { title: 'x'.repeat(201) }, { title: '\ud800' }, { title: 'a\u2028b' }, { title: 'a\u2029b' }, { title: 'ok', description: 'a\u0007' }, { title: 'ok', extra: 1 }]) {
    assert.equal((await anna.request('POST', '/api/elections', body)).statusCode, 400, JSON.stringify(body))
  }
  assert.deepEqual((await anna.request('GET', '/api/elections')).json(), [])
  const ok = await anna.request('POST', '/api/elections', { title: 'Wahl über „Schulball“ 🎉', description: 'Zeile 1\r\nZeile\t2' })
  assert.equal(ok.statusCode, 201)
})

test('a display name too long or malformed for the audit log is bounded at sign-in, so creating and binding still work', DB, async (t) => {
  const s = await electionApp(t)
  // 405 UTF-16 code units; the cut must not split an emoji's surrogate pair.
  const longName = `Anna ${'😀'.repeat(200)}`
  const anna = await signIn(s, { ...ANNA, name: longName })
  const id = await createElection(anna)
  assert.equal((await invite(anna, id, WANDA.email)).statusCode, 201)
  await signIn(s, { ...WANDA, name: `Wanda \ud800Zeugin\u0000${'x'.repeat(300)}` })
  const { events, chain } = await auditLog(anna, id)
  assert.deepEqual(chain, { valid: true, length: 3, head: events[2]?.hash })
  assert.deepEqual(events.map((e) => e.actor.name), [
    longName.slice(0, 255),
    longName.slice(0, 255),
    `Wanda �Zeugin${'x'.repeat(243)}`,
  ])
  assert.deepEqual((await members(anna, id)).map((m) => m.displayName?.length), [255, 256])
})

test('a stored display name longer than the audit log holds is bounded wherever it becomes an actor', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  // A row stored before names were bounded at sign-in, with the session that still names it.
  const longName = `Anna ${'😀'.repeat(200)}`
  await withClient(s.ownerUrl, (c) => c.query('update app_user set display_name = $1 where oid = $2', [longName, ANNA.oid]))
  assert.equal((await invite(anna, id, WANDA.email)).statusCode, 201)
  assert.equal((await anna.request('POST', '/api/elections', { title: 'Zweite Wahl' })).statusCode, 201)
  const { events, chain } = await auditLog(anna, id)
  assert.deepEqual(chain, { valid: true, length: 2, head: events[1]?.hash })
  assert.deepEqual(events.map((e) => e.actor.name), [ANNA.name, longName.slice(0, 255)])
})

test('a final election binds no more invitations; another tenant\'s person binds none', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  assert.equal((await invite(anna, id, WANDA.email)).statusCode, 201)
  await forceElectionState(s.ownerUrl, id, 'final')
  const wanda = await signIn(s, WANDA)
  assert.equal((await wanda.request('GET', `/api/elections/${id}`)).statusCode, 404)
  await forceElectionState(s.ownerUrl, id, 'draft')

  // Sign-in only lets the configured tenant in; the binding checks it all the same.
  const foreign = { tid: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', oid: 'f0000000-0000-4000-8000-00000000000f', displayName: 'Fremd', email: WANDA.email ?? null }
  await s.db.tx(async (client) => {
    const { rows: [user] } = await client.query<{ id: string }>(
      'insert into app_user (tid, oid, display_name, email) values ($1, $2, $3, $4) returning id',
      [foreign.tid, foreign.oid, foreign.displayName, foreign.email],
    )
    assert.ok(user)
    await bindInvitations(client, user.id, foreign, TENANT_ID)
  })
  assert.deepEqual((await members(anna, id)).map((m) => m.status), ['bound', 'pending'])
  assert.deepEqual(await auditActions(anna, id), ['election.created', 'member.invited'])
})
