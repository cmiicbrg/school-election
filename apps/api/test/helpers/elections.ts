// The app with a real database and the Entra stand-in, and people who sign
// in to it the way a browser does, for the election and membership tests.

import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse, RouteOptions } from 'fastify'
import { createDatabase, type Database } from '../../lib/db.ts'
import type { ElectionState } from '@school-election/election-core'
import { buildTestApp, ORIGIN } from './app.ts'
import { createTestDatabase, withClient } from './db.ts'
import { CookieJar, startFakeEntra, type FakeEntra } from './fake-entra.ts'

export interface ElectionApp {
  app: FastifyInstance
  db: Database
  entra: FakeEntra
  ownerUrl: string
  /** Every route the app registered. */
  routes: RouteOptions[]
  /** Every log line the app has written so far, raw. */
  logs: () => string
}

export async function electionApp(t: TestContext): Promise<ElectionApp> {
  const entra = await startFakeEntra()
  t.after(() => entra.close())
  const testDb = await createTestDatabase(t)
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  const routes: RouteOptions[] = []
  const { app, logs } = await buildTestApp({}, db, { entraAuthority: entra.authority, onRoute: (route) => routes.push(route) })
  t.after(() => app.close())
  return { app, db, entra, ownerUrl: testDb.ownerUrl, routes, logs }
}

export interface Person {
  oid: string
  name: string
  /** The email claim; undefined leaves it out. */
  email?: string
  preferredUsername?: string
  roles?: string[]
}

export const ANNA: Person = { oid: 'a0000000-0000-4000-8000-00000000000a', name: 'Anna Lehrerin', email: 'anna.lehrerin@schule.example.org', roles: ['teacher'] }
export const BERND: Person = { oid: 'b0000000-0000-4000-8000-00000000000b', name: 'Bernd Lehrer', email: 'bernd.lehrer@schule.example.org', roles: ['teacher'] }
export const CARLA: Person = { oid: 'c0000000-0000-4000-8000-00000000000c', name: 'Carla Kollegin', email: 'carla.kollegin@schule.example.org', roles: ['teacher'] }
export const WANDA: Person = { oid: 'd0000000-0000-4000-8000-00000000000d', name: 'Wanda Zeugin', email: 'wanda.zeugin@schule.example.org' }

/** A signed-in browser: its requests are same-origin and carry its cookies. */
export interface Browser {
  request: (method: InjectOptions['method'], url: string, body?: object, headers?: Record<string, string>) => Promise<LightMyRequestResponse>
}

export async function signIn(s: ElectionApp, person: Person): Promise<Browser> {
  const jar = new CookieJar()
  const login = await s.app.inject({ method: 'GET', url: '/api/auth/login' })
  assert.equal(login.statusCode, 302)
  jar.update(login)
  const callback = new URL(s.entra.authorize(String(login.headers.location), {
    claims: {
      oid: person.oid,
      name: person.name,
      email: person.email,
      preferred_username: person.preferredUsername ?? person.email,
      roles: person.roles ?? [],
    },
  }), ORIGIN)
  const res = await s.app.inject({ method: 'GET', url: callback.pathname + callback.search, headers: { cookie: jar.header() } })
  assert.equal(res.statusCode, 303, `sign-in of ${person.name}`)
  jar.update(res)
  return {
    request: (method, url, body, headers = {}) => s.app.inject({
      method,
      url,
      headers: { ...headers, 'cookie': jar.header(), 'sec-fetch-site': 'same-origin' },
      ...(body === undefined ? {} : { payload: body }),
    }),
  }
}

/** Creates an election as `owner` and returns its id. */
export async function createElection(owner: Browser, title = 'Schulsprecherwahl 2026/27'): Promise<string> {
  const res = await owner.request('POST', '/api/elections', { title })
  assert.equal(res.statusCode, 201, res.body)
  return res.json<{ id: string }>().id
}

/** The audit actions of an election, in chain order, read as the owner. */
export async function auditActions(owner: Browser, electionId: string): Promise<string[]> {
  const res = await owner.request('GET', `/api/elections/${electionId}/audit`)
  assert.equal(res.statusCode, 200)
  return res.json<{ events: { action: string }[] }>().events.map((event) => event.action)
}

/**
 * Puts an election into a state no route reaches yet (none opens a round),
 * or back out of one, as the database owner and past the lifecycle
 * triggers, which would otherwise refuse such a jump.
 */
export async function forceElectionState(ownerUrl: string, electionId: string, state: ElectionState): Promise<void> {
  await withClient(ownerUrl, async (client) => {
    await client.query('begin')
    await client.query('set local session_replication_role = replica')
    await client.query('update election set state = $2 where id = $1', [electionId, state])
    await client.query('commit')
  })
}

/** A route's URL for an election, with made-up ids for everything else it names. */
export function electionPath(pattern: string, electionId: string): string {
  return pattern.replace(':id', electionId).replace(':sha256', 'a'.repeat(64)).replaceAll(/:[a-zA-Z]+Id\b/g, '0d3b5a0e-6a43-4c1b-9f5e-3d2c1b0a9f8e')
}
