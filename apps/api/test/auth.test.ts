import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { callerOf, requireGlobalRole, requireSession } from '../lib/auth.ts'
import { createDatabase, type Database } from '../lib/db.ts'
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_SECONDS, type SessionUser } from '../plugins/session.ts'
import { buildTestApp, ORIGIN, stubDatabase } from './helpers/app.ts'
import { createTestDatabase, DB } from './helpers/db.ts'
import { secretFile, TENANT_ID } from './helpers/env.ts'
import { STATE_COOKIE } from '../lib/entra.ts'
import { CookieJar, ISSUER, startFakeEntra, type AuthorizeOptions, type FakeEntra } from './helpers/fake-entra.ts'

const sameOrigin = { 'sec-fetch-site': 'same-origin' }
const VERIFIER_COOKIE = '__Host-oauth2-code-verifier'

interface Setup {
  app: FastifyInstance
  entra: FakeEntra
  db: Database
  logs: () => string
}

async function setup(t: TestContext, { withDatabase = true } = {}): Promise<Setup> {
  const entra = await startFakeEntra()
  t.after(() => entra.close())
  let db = stubDatabase()
  if (withDatabase) {
    const testDb = await createTestDatabase(t)
    db = createDatabase(testDb.runtimeUrl, () => {})
    t.after(() => db.close())
  }
  const { app, logs } = await buildTestApp({}, db, { entraAuthority: entra.authority })
  app.get('/api/test/teacher-only', { preHandler: requireGlobalRole('teacher') }, () => ({ ok: true }))
  t.after(() => app.close())
  return { app, entra, db, logs }
}

/** Login, the user at Entra, the callback: what a browser does. */
async function signIn(s: Setup, jar: CookieJar, options: AuthorizeOptions & { returnTo?: string, beforeCallback?: (callback: URL) => void } = {}) {
  const query = options.returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(options.returnTo)}`
  const login = await s.app.inject({ method: 'GET', url: `/api/auth/login${query}`, headers: { cookie: jar.header() } })
  assert.equal(login.statusCode, 302)
  jar.update(login)
  const callback = new URL(s.entra.authorize(String(login.headers.location), options), ORIGIN)
  options.beforeCallback?.(callback)
  const res = await s.app.inject({ method: 'GET', url: callback.pathname + callback.search, headers: { cookie: jar.header() } })
  jar.update(res)
  return res
}

async function me(app: FastifyInstance, jar: CookieJar) {
  return app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: jar.header() } })
}

async function appUsers(db: Database) {
  return (await db.query<{ tid: string, oid: string, display_name: string, email: string | null }>('select tid, oid, display_name, email from app_user order by display_name')).rows
}

test('login sends the browser to the tenant with state and nonce, without PKCE, without contacting Entra', async (t) => {
  const s = await setup(t, { withDatabase: false })
  const res = await s.app.inject({ method: 'GET', url: '/api/auth/login?returnTo=/admin' })
  assert.equal(res.statusCode, 302)
  const location = new URL(String(res.headers.location))
  assert.equal(location.origin + location.pathname, `${s.entra.authority}/${TENANT_ID}/oauth2/v2.0/authorize`)
  const params = Object.fromEntries(location.searchParams)
  assert.equal(params.response_type, 'code')
  assert.equal(params.redirect_uri, `${ORIGIN}/api/auth/callback`)
  assert.equal(params.scope, 'openid email profile')
  assert.match(params.nonce ?? '', /^[\w-]{43}$/)
  assert.ok((params.state ?? '').length >= 20)
  // No PKCE, and single sign-on unless Entra asked for a reload.
  assert.deepEqual([params.code_challenge, params.code_challenge_method, params.prompt], [undefined, undefined, undefined])

  const cookies = new Map(res.cookies.map((cookie) => [cookie.name, cookie]))
  const state = cookies.get(STATE_COOKIE)
  assert.deepEqual([state?.path, state?.secure, state?.httpOnly, state?.sameSite, state?.maxAge], ['/', true, true, 'Lax', 600])
  assert.equal(state?.value, params.state)
  assert.ok(!cookies.has(VERIFIER_COOKIE))
  assert.ok(cookies.has(ADMIN_SESSION_COOKIE), 'the pending sign-in is sealed into the session cookie')
  assert.ok(!res.body.includes(params.nonce ?? '-'))
  assert.deepEqual(s.entra.requests, [])
})

test('in production the authorization request goes to the tenant at login.microsoftonline.com', async (t) => {
  const { app } = await buildTestApp()
  t.after(() => app.close())
  const res = await app.inject({ method: 'GET', url: '/api/auth/login' })
  assert.ok(String(res.headers.location).startsWith(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?`))
  // HEAD is not a way into sign-in.
  assert.equal((await app.inject({ method: 'HEAD', url: '/api/auth/login' })).statusCode, 404)
})

test('a teacher signs in: sealed session, return path, app_user row, no token in the browser', DB, async (t) => {
  const s = await setup(t)
  const jar = new CookieJar()
  const res = await signIn(s, jar, { returnTo: '/admin/elections?tab=open' })
  assert.equal(res.statusCode, 303)
  assert.equal(res.headers.location, '/admin/elections?tab=open')
  assert.equal(res.body, '')

  const session = res.cookies.find((cookie) => cookie.name === ADMIN_SESSION_COOKIE)
  assert.deepEqual(
    [session?.path, session?.secure, session?.httpOnly, session?.sameSite, session?.maxAge, session?.domain],
    ['/', true, true, 'Lax', ADMIN_SESSION_SECONDS, undefined],
  )
  assert.equal(ADMIN_SESSION_SECONDS, 8 * 3600)
  // The state is used up.
  assert.ok(!jar.values.has(STATE_COOKIE))
  const who = await me(s.app, jar)
  assert.equal(who.statusCode, 200)
  assert.equal(s.entra.issued.length, 2)
  const seenByBrowser: string[] = [JSON.stringify(res.headers), res.body, who.body]
  for (const token of s.entra.issued) {
    for (const part of seenByBrowser) assert.ok(!part.includes(token), 'a token reached the browser')
  }
  const body = who.json<{ id: string, displayName: string, roles: string[] }>()
  assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.deepEqual([body.displayName, body.roles], ['Maria Muster', ['teacher']])
  assert.deepEqual(await appUsers(s.db), [{
    tid: TENANT_ID,
    oid: 'c0ffee00-1234-4abc-8def-0123456789ab',
    display_name: 'Maria Muster',
    email: 'maria.muster@schule.example.org',
  }])
  assert.equal((await s.app.inject({ method: 'GET', url: '/api/test/teacher-only', headers: { cookie: jar.header() } })).statusCode, 200)
})

test('an unsafe return path falls back to the start page', DB, async (t) => {
  const s = await setup(t)
  for (const returnTo of ['//evil.example', 'https://evil.example/', '/\\evil.example']) {
    const res = await signIn(s, new CookieJar(), { returnTo })
    assert.equal(res.headers.location, '/', returnTo)
  }
})

test('every failed check ends without a session and without an app_user row', DB, async (t) => {
  const s = await setup(t)
  const now = Math.floor(Date.now() / 1000)
  const otherGuid = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a'
  const claimCheck = 'ERR_JWT_CLAIM_VALIDATION_FAILED'
  // Each case with the reason the log must give for it.
  const cases: Array<[string, string, AuthorizeOptions & { beforeCallback?: (callback: URL) => void, dropCookie?: string }]> = [
    ['another tenant', 'wrong_tenant', { claims: { tid: otherGuid } }],
    ['another issuer', claimCheck, { claims: { iss: `https://login.microsoftonline.com/${otherGuid}/v2.0` } }],
    ['the common issuer', claimCheck, { claims: { iss: 'https://login.microsoftonline.com/common/v2.0' } }],
    ['another audience', claimCheck, { claims: { aud: otherGuid } }],
    ['an expired token', 'ERR_JWT_EXPIRED', { claims: { iat: now - 7200, nbf: now - 7200, exp: now - 3600 } }],
    ['no oid', claimCheck, { claims: { oid: undefined } }],
    ['an oid that is no GUID', 'no_oid', { claims: { oid: 'someone' } }],
    ['no tid', claimCheck, { claims: { tid: undefined } }],
    ['another nonce', 'wrong_nonce', { claims: { nonce: 'replayed-nonce' } }],
    ['no nonce', claimCheck, { claims: { nonce: undefined } }],
    ['a signature by another key', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', { signWith: 'foreign' }],
    ['an HMAC signature with the client secret', 'ERR_JOSE_ALG_NOT_ALLOWED', { signWith: 'hs256' }],
    ['another state', 'state_mismatch', { beforeCallback: (callback) => callback.searchParams.set('state', 'forged') }],
    ['no state', 'state_mismatch', { beforeCallback: (callback) => callback.searchParams.delete('state') }],
    ['no code', 'no_code', { beforeCallback: (callback) => callback.searchParams.delete('code') }],
    ['an error from Entra', 'no_code', { beforeCallback: (callback) => callback.searchParams.set('error', 'access_denied') }],
    ['no pending sign-in', 'no_pending_sign_in', { dropCookie: ADMIN_SESSION_COOKIE }],
  ]
  for (const [name, reason, options] of cases) {
    const jar = new CookieJar()
    const logged = s.logs().length
    const res = await signIn(s, jar, {
      ...options,
      beforeCallback: (callback) => {
        options.beforeCallback?.(callback)
        if (options.dropCookie) jar.values.delete(options.dropCookie)
      },
    })
    assert.equal(res.statusCode, 401, name)
    assert.deepEqual(res.json(), { error: 'sign_in_failed' }, name)
    assert.match(s.logs().slice(logged), new RegExp(`"code":"${reason}".*"msg":"sign-in refused"`), name)
    assert.equal((await me(s.app, jar)).statusCode, 204, name)
  }
  assert.deepEqual(await appUsers(s.db), [])
  // A missing or forged state, a missing code, an Entra error and a missing
  // pending sign-in never reach the token endpoint.
  assert.equal(s.entra.requests.filter((request) => request.startsWith('POST')).length, 12)
  const log = s.logs()
  assert.ok(s.entra.issued.length > 0)
  for (const secret of [...s.entra.issued, 'Maria Muster', 'maria.muster', 'c0ffee00', 'access_denied']) {
    assert.ok(!log.includes(secret), `log contains ${secret}`)
  }
})

test('a callback without the state of this browser\'s sign-in leaves that sign-in in progress', DB, async (t) => {
  const s = await setup(t)
  const jar = new CookieJar()
  const login = await s.app.inject({ method: 'GET', url: '/api/auth/login?returnTo=/admin' })
  jar.update(login)
  const callback = new URL(s.entra.authorize(String(login.headers.location)), ORIGIN)
  // Another site sends the browser to the callback first: the cookies come
  // along, the state does not.
  for (const forged of ['?error=access_denied', '?error=access_denied&state=', '?code=x&state=forged', '?code=x']) {
    const logged = s.logs().length
    const res = await s.app.inject({ method: 'GET', url: `/api/auth/callback${forged}`, headers: { cookie: jar.header() } })
    assert.equal(res.statusCode, 401, forged)
    assert.match(s.logs().slice(logged), /"code":"state_mismatch".*"msg":"sign-in refused"/, forged)
    jar.update(res)
  }
  assert.deepEqual(s.entra.requests, [])
  const res = await s.app.inject({ method: 'GET', url: callback.pathname + callback.search, headers: { cookie: jar.header() } })
  assert.deepEqual([res.statusCode, res.headers.location], [303, '/admin'])
})

test('an unreachable token endpoint is logged as a failed token request, not as a forged state', async (t) => {
  const s = await setup(t, { withDatabase: false })
  const jar = new CookieJar()
  const login = await s.app.inject({ method: 'GET', url: '/api/auth/login' })
  jar.update(login)
  const callback = s.entra.authorize(String(login.headers.location))
  await s.entra.close()
  const res = await s.app.inject({ method: 'GET', url: callback, headers: { cookie: jar.header() } })
  assert.equal(res.statusCode, 401)
  assert.match(s.logs(), /"code":"token_request_failed".*"msg":"sign-in refused"/)
  assert.doesNotMatch(s.logs(), /state_mismatch/)
})

test('a callback works once', DB, async (t) => {
  const s = await setup(t)
  const jar = new CookieJar()
  const replay = new CookieJar()
  let url = ''
  await signIn(s, jar, {
    beforeCallback: (callback) => {
      url = callback.pathname + callback.search
      for (const [name, value] of jar.values) replay.values.set(name, value)
    },
  })
  assert.equal((await me(s.app, jar)).statusCode, 200)
  // The same callback with the cookies from before it: the code is spent.
  const res = await s.app.inject({ method: 'GET', url, headers: { cookie: replay.header() } })
  assert.equal(res.statusCode, 401)
  replay.update(res)
  assert.equal((await me(s.app, replay)).statusCode, 204)
})

test('roles come through an allow-list; signing in without one grants nothing', DB, async (t) => {
  const s = await setup(t)
  for (const [roles, expected] of [
    [undefined, []],
    [[], []],
    [['admin'], []],
    [['Teacher', 'owner', 'student'], []],
    [['admin', 'teacher', 'teacher'], ['teacher']],
    ['teacher', []],
  ] as const) {
    const jar = new CookieJar()
    assert.equal((await signIn(s, jar, { claims: { roles } })).statusCode, 303, JSON.stringify(roles))
    assert.deepEqual((await me(s.app, jar)).json<{ roles: string[] }>().roles, expected, JSON.stringify(roles))
    const guarded = await s.app.inject({ method: 'GET', url: '/api/test/teacher-only', headers: { cookie: jar.header() } })
    assert.equal(guarded.statusCode, expected.length > 0 ? 200 : 403, JSON.stringify(roles))
  }
  assert.equal((await s.app.inject({ method: 'GET', url: '/api/test/teacher-only' })).statusCode, 401)
})

test('signing in again refreshes name and email of the same person: the email claim, else preferred_username, else null', DB, async (t) => {
  const s = await setup(t)
  const first = new CookieJar()
  await signIn(s, first)
  const maria = (name: string, email: string | null) => [{ tid: TENANT_ID, oid: 'c0ffee00-1234-4abc-8def-0123456789ab', display_name: name, email }]
  for (const [claims, expected] of [
    [{ name: 'Maria Muster-Neu', email: 'Maria.Muster@schule.example.org' }, maria('Maria Muster-Neu', 'Maria.Muster@schule.example.org')],
    [{ email: undefined, preferred_username: 'm.muster@schule.example.org' }, maria('Maria Muster', 'm.muster@schule.example.org')],
    [{ email: ' ', preferred_username: 'm.muster@schule.example.org' }, maria('Maria Muster', 'm.muster@schule.example.org')],
    [{ email: undefined, preferred_username: undefined }, maria('Maria Muster', null)],
  ] as const) {
    const again = new CookieJar()
    await signIn(s, again, { claims })
    assert.equal((await me(s.app, first)).json<{ id: string }>().id, (await me(s.app, again)).json<{ id: string }>().id)
    assert.deepEqual(await appUsers(s.db), expected, JSON.stringify(claims))
  }
})

test('when Entra sends the browser back with sso_reload, the retry asks for the interactive sign-in', DB, async (t) => {
  const s = await setup(t)
  for (const query of ['sso_reload=false', 'sso_reload=', 'returnTo=/admin']) {
    const res = await s.app.inject({ method: 'GET', url: `/api/auth/login?${query}` })
    assert.equal(new URL(String(res.headers.location)).searchParams.get('prompt'), null, query)
  }
  // Parameters of Entra's own are ignored. The retry is a sign-in like any
  // other, with a fresh state and nonce, and keeps the return path.
  const jar = new CookieJar()
  const retry = await s.app.inject({ method: 'GET', url: '/api/auth/login?returnTo=/admin&sso_reload=true&client-request-id=x' })
  assert.equal(retry.statusCode, 302)
  jar.update(retry)
  const location = String(retry.headers.location)
  assert.equal(new URL(location).searchParams.get('prompt'), 'login')
  const callback = new URL(s.entra.authorize(location), ORIGIN)
  const res = await s.app.inject({ method: 'GET', url: callback.pathname + callback.search, headers: { cookie: jar.header() } })
  assert.deepEqual([res.statusCode, res.headers.location], [303, '/admin'])
  jar.update(res)
  assert.equal((await me(s.app, jar)).statusCode, 200)
})

/** A session cookie as the app would seal it. */
function sealed(app: FastifyInstance, data: Record<string, unknown>): string {
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(app.encodeSecureSession(app.createSecureSession(data), 'adminSession'))}`
}

const user = (issuedAt = Date.now()): SessionUser => ({ id: '0d3b5a0e-6a43-4c1b-9f5e-3d2c1b0a9f8e', displayName: 'Maria Muster', roles: ['teacher'], issuedAt })

test('a sealed session is accepted only as issued, by this key, within its lifetime', async (t) => {
  const { app } = await buildTestApp()
  t.after(() => app.close())
  const get = (cookie?: string) => app.inject({ method: 'GET', url: '/api/auth/me', headers: cookie ? { cookie } : {} })

  const none = await get()
  assert.equal(none.statusCode, 204)
  assert.equal(none.body, '')

  const valid = sealed(app, { user: user() })
  assert.equal((await get(valid)).statusCode, 200)

  const value = decodeURIComponent(valid.slice(ADMIN_SESSION_COOKIE.length + 1))
  const [cipher = '', nonce = ''] = value.split(';')
  const flipped = cipher.slice(0, 10) + (cipher[10] === 'A' ? 'B' : 'A') + cipher.slice(11)
  for (const [name, forged] of [
    ['tampered', `${flipped};${nonce}`],
    ['truncated', cipher.slice(0, 20)],
    ['without nonce', cipher],
    ['garbage', 'x'],
  ] as const) {
    assert.equal((await get(`${ADMIN_SESSION_COOKIE}=${encodeURIComponent(forged)}`)).statusCode, 204, name)
  }

  const other = await buildTestApp({ SESSION_KEY_FILE: secretFile('other-session-key', randomBytes(32).toString('hex')) })
  t.after(() => other.app.close())
  assert.equal((await get(sealed(other.app, { user: user() }))).statusCode, 204, 'sealed with another key')

  const expiredAt = Date.now() - ADMIN_SESSION_SECONDS * 1000 - 1000
  assert.equal((await get(sealed(app, { user: user(expiredAt) }))).statusCode, 204, 'signed in more than 8 hours ago')
  for (const issuedAt of [undefined, null, 'now', Number.NaN]) {
    assert.equal((await get(sealed(app, { user: { ...user(), issuedAt } }))).statusCode, 204, `issuedAt ${String(issuedAt)}`)
  }
  assert.equal((await get(sealed(app, { __ts: Math.floor(expiredAt / 1000), user: user() }))).statusCode, 204, 'cookie sealed more than 8 hours ago')
  assert.equal((await get(sealed(app, { signIn: { nonce: 'n', returnTo: '/', startedAt: Date.now() } }))).statusCode, 204, 'a pending sign-in is no session')
})

test('a request the guard let through keeps its caller, even if the session expires meanwhile', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const { app } = await buildTestApp()
  t.after(() => app.close())
  // The guard, then a slow step (a later election check, say) that crosses the 8-hour mark.
  const slow = (_request: unknown, _reply: unknown, done: () => void) => {
    t.mock.timers.tick(5000)
    done()
  }
  app.get('/api/test/caller', { preHandler: [requireSession, slow] }, (request) => ({ name: callerOf(request).displayName }))
  app.get('/api/test/unguarded', (request) => ({ name: callerOf(request).displayName }))

  const cookie = sealed(app, { user: user(Date.now() - ADMIN_SESSION_SECONDS * 1000 + 1000) })
  const res = await app.inject({ method: 'GET', url: '/api/test/caller', headers: { cookie } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { name: 'Maria Muster' })
  // The next request finds the session expired.
  assert.equal((await app.inject({ method: 'GET', url: '/api/test/caller', headers: { cookie } })).statusCode, 401)
  // Without a guard there is no caller: a programming error, never a pass.
  assert.equal((await app.inject({ method: 'GET', url: '/api/test/unguarded', headers: { cookie: sealed(app, { user: user() }) } })).statusCode, 500)
})

test('logout clears the session cookie and is a protected state change', async (t) => {
  const { app } = await buildTestApp()
  t.after(() => app.close())
  const cookie = sealed(app, { user: user() })
  const crossSite = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { 'sec-fetch-site': 'cross-site', cookie } })
  assert.equal(crossSite.statusCode, 403)

  const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...sameOrigin, cookie } })
  assert.equal(res.statusCode, 204)
  const cleared = res.cookies.find((c) => c.name === ADMIN_SESSION_COOKIE)
  assert.deepEqual([cleared?.value, cleared?.maxAge, cleared?.path, cleared?.secure], ['', 0, '/', true])
  // There is no GET logout to trigger from another site.
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/logout', headers: { cookie } })).statusCode, 404)
})

test('sign-in is rate-limited per client address, and nothing else is', async (t) => {
  const { app, logs } = await buildTestApp()
  t.after(() => app.close())
  const from = (remoteAddress: string, url: string) => app.inject({ method: 'GET', url, remoteAddress })
  for (const url of ['/api/auth/login', '/api/auth/callback']) {
    for (let i = 0; i < 60; i++) assert.notEqual((await from('198.51.100.7', url)).statusCode, 429, `${url} #${i + 1}`)
    const limited = await from('198.51.100.7', url)
    assert.equal(limited.statusCode, 429, url)
    assert.deepEqual(limited.json(), { error: 'rate_limited' })
    assert.ok(Number(limited.headers['retry-after']) > 0)
    assert.notEqual((await from('203.0.113.9', url)).statusCode, 429, `${url} from another address`)
  }
  for (let i = 0; i < 70; i++) assert.equal((await from('198.51.100.7', '/api/auth/me')).statusCode, 204)
  assert.ok(!logs().includes('198.51.100.7'))
})

test('the callback is the only GET that starts a session, and only with a pending sign-in', async (t) => {
  const { app } = await buildTestApp()
  t.after(() => app.close())
  const res = await app.inject({ method: 'GET', url: `/api/auth/callback?code=x&state=y&iss=${encodeURIComponent(ISSUER)}` })
  assert.equal(res.statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/callback?code=x&code=y' })).statusCode, 400)
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/login?returnTo=/a&returnTo=/b' })).statusCode, 400)
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/login?sso_reload=true&sso_reload=true' })).statusCode, 400)
})
