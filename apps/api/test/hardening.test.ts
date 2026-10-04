import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Type } from 'typebox'
import { TALLY_VERSION } from '@school-election/election-core'
import { StrictObject } from '../lib/schemas/common.ts'
import { buildTestApp, fakeWebDist, ORIGIN } from './helpers/app.ts'

const sameOrigin = { 'sec-fetch-site': 'same-origin' }

async function appWithTestRoutes(env: Record<string, string> = {}) {
  const built = await buildTestApp(env)
  built.app.get('/api/test/client', (request) => ({ ip: request.ip, protocol: request.protocol }))
  built.app.post('/api/test/echo', { schema: { body: StrictObject({ n: Type.Number() }) } }, (request) => request.body)
  built.app.post('/api/test/throw', () => {
    throw Object.assign(new Error('Key (credential_hash)=(MESSAGESECRET) already exists'), { code: '23505', detail: 'DETAILSECRET' })
  })
  // A message whose lines look like stack frames.
  built.app.post('/api/test/throw-multiline', () => {
    throw new Error('first line\n    at FRAMELIKESECRET (key.ts:1:1)')
  })
  // A message changed after the stack was captured.
  built.app.post('/api/test/throw-mutated', () => {
    const err = new Error('original')
    err.message = 'MUTATEDSECRET'
    err.stack = 'Error: MUTATEDSECRET\n    at MUTATEDFRAME (key.ts:1:1)'.replace('MUTATEDSECRET', 'STACKSECRET')
    throw err
  })
  return built
}

test('security headers come from the application', async (t) => {
  const { app } = await buildTestApp()
  t.after(() => app.close())
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { status: 'ok', db: 'up', version: 'dev', gitSha: 'unknown', tallyVersion: TALLY_VERSION })
  assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('forwarded headers count only from a trusted proxy', async (t) => {
  const headers = { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' }
  const untrusted = await appWithTestRoutes()
  t.after(() => untrusted.app.close())
  const direct = await untrusted.app.inject({ method: 'GET', url: '/api/test/client', remoteAddress: '203.0.113.5', headers })
  assert.deepEqual(direct.json(), { ip: '203.0.113.5', protocol: 'http' })

  const trusted = await appWithTestRoutes({ TRUST_PROXY: '203.0.113.0/24' })
  t.after(() => trusted.app.close())
  const proxied = await trusted.app.inject({ method: 'GET', url: '/api/test/client', remoteAddress: '203.0.113.5', headers })
  assert.deepEqual(proxied.json(), { ip: '198.51.100.7', protocol: 'https' })
})

test('state-changing requests must come from our own origin', async (t) => {
  const { app } = await appWithTestRoutes()
  t.after(() => app.close())
  const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/test/echo', headers, payload: { n: 1 } })

  assert.equal((await post({ 'sec-fetch-site': 'cross-site', 'origin': 'https://evil.example' })).statusCode, 403)
  assert.equal((await post({ 'sec-fetch-site': 'same-site' })).statusCode, 403)
  // Origin is checked only when fetch metadata is missing, and must match.
  assert.equal((await post({ origin: 'https://evil.example' })).statusCode, 403)
  assert.equal((await post({})).statusCode, 403)
  assert.deepEqual((await post({ 'sec-fetch-site': 'cross-site', 'origin': 'https://evil.example' })).json(), { error: 'cross_site_request' })

  assert.equal((await post(sameOrigin)).statusCode, 200)
  assert.equal((await post({ origin: ORIGIN })).statusCode, 200)

  // Reading is unaffected.
  const read = await app.inject({ method: 'GET', url: '/api/health', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(read.statusCode, 200)
})

test('request bodies must be JSON', async (t) => {
  const { app } = await appWithTestRoutes()
  t.after(() => app.close())
  for (const [contentType, payload] of [
    ['application/x-www-form-urlencoded', 'n=1'],
    ['text/plain', '{"n":1}'],
    ['multipart/form-data; boundary=x', '--x--'],
  ] as const) {
    const res = await app.inject({ method: 'POST', url: '/api/test/echo', headers: { ...sameOrigin, 'content-type': contentType }, payload })
    assert.equal(res.statusCode, 415, contentType)
  }
})

test('schemas are strict: no stripping, no coercion', async (t) => {
  const { app } = await appWithTestRoutes()
  t.after(() => app.close())
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/test/echo', headers: sameOrigin, payload: payload as object })
  const extra = await post({ n: 1, extra: true })
  assert.equal(extra.statusCode, 400)
  assert.equal(extra.json<{ error: string }>().error, 'FST_ERR_VALIDATION')
  assert.equal((await post({ n: '1' })).statusCode, 400)
  assert.deepEqual((await post({ n: 1 })).json(), { n: 1 })
})

test('a failing request logs no query, address or body and answers without a stack', async (t) => {
  const { app, logs } = await appWithTestRoutes()
  t.after(() => app.close())
  const res = await app.inject({
    method: 'POST',
    url: '/api/test/throw?key=QUERYSECRET',
    remoteAddress: '198.51.100.23',
    headers: { ...sameOrigin, 'user-agent': 'AGENTSECRET', 'cookie': 'session=COOKIESECRET' },
    payload: { ballot: 'BODYSECRET' },
  })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), { error: 'internal_error' })

  const output = logs()
  assert.match(output, /request failed/)
  assert.match(output, /"path":"\/api\/test\/throw"/)
  // The error is identifiable by type, code and where it was thrown.
  assert.match(output, /"type":"Error"/)
  assert.match(output, /"code":"23505"/)
  assert.match(output, /hardening\.test\.ts/)
  for (const secret of ['QUERYSECRET', '198.51.100.23', 'BODYSECRET', 'AGENTSECRET', 'COOKIESECRET', 'MESSAGESECRET', 'DETAILSECRET', 'remoteAddress', 'remotePort']) {
    assert.ok(!output.includes(secret), `log contains ${secret}`)
  }
})

test('message lines are never logged as stack frames', async (t) => {
  const { app, logs } = await appWithTestRoutes()
  t.after(() => app.close())
  for (const url of ['/api/test/throw-multiline', '/api/test/throw-mutated']) {
    const res = await app.inject({ method: 'POST', url, headers: sameOrigin, payload: {} })
    assert.equal(res.statusCode, 500)
  }
  for (const secret of ['FRAMELIKESECRET', 'MUTATEDSECRET', 'STACKSECRET', 'MUTATEDFRAME']) {
    assert.ok(!logs().includes(secret), `log contains ${secret}`)
  }
  assert.match(logs(), /hardening\.test\.ts/)
})

test('a local debug log leaves the error message out too', async (t) => {
  const { app, logs } = await appWithTestRoutes({ PUBLIC_ORIGIN: 'http://localhost:5173', LOG_LEVEL: 'debug' })
  t.after(() => app.close())
  await app.inject({ method: 'POST', url: '/api/test/throw', headers: sameOrigin, payload: {} })
  assert.match(logs(), /request failed/)
  for (const secret of ['MESSAGESECRET', 'DETAILSECRET']) assert.ok(!logs().includes(secret), `log contains ${secret}`)
})

test('an unparsable body is refused without echoing it', async (t) => {
  const { app } = await appWithTestRoutes()
  t.after(() => app.close())
  const res = await app.inject({
    method: 'POST',
    url: '/api/test/echo',
    headers: { ...sameOrigin, 'content-type': 'application/json' },
    payload: '{"key":"KEYSECRET',
  })
  assert.equal(res.statusCode, 400)
  assert.ok(!res.body.includes('KEYSECRET'))
})

test('unknown API paths get JSON; other page paths get the web app', async (t) => {
  const { app } = await buildTestApp({ WEB_DIST_DIR: fakeWebDist() })
  t.after(() => app.close())

  for (const url of ['/api/nope', '/api']) {
    const api = await app.inject({ method: 'GET', url })
    assert.equal(api.statusCode, 404, url)
    assert.deepEqual(api.json(), { error: 'not_found' })
    assert.equal(api.headers['cache-control'], 'no-store', url)
  }

  const page = await app.inject({ method: 'GET', url: '/admin/elections/42?tab=x' })
  assert.equal(page.statusCode, 200)
  assert.match(String(page.headers['content-type']), /text\/html/)
  assert.match(page.body, /<title>app<\/title>/)
  assert.equal(page.headers['cache-control'], 'no-cache')

  // The voter page is a page path like any other, with the same policy; a
  // fragment on it is the browser's alone and never reaches the server.
  const voter = await app.inject({ method: 'GET', url: '/v' })
  assert.equal(voter.statusCode, 200)
  assert.match(String(voter.headers['content-type']), /text\/html/)
  assert.match(String(voter.headers['content-security-policy']), /default-src 'self'/)
  assert.match(String(voter.headers['content-security-policy']), /frame-ancestors 'none'/)
  assert.equal(voter.headers['referrer-policy'], 'no-referrer')
  assert.equal(voter.headers['x-content-type-options'], 'nosniff')

  for (const url of ['/assets/missing.js', '/assets/chunk', '/assets']) {
    const asset = await app.inject({ method: 'GET', url })
    assert.equal(asset.statusCode, 404, url)
    assert.deepEqual(asset.json(), { error: 'not_found' })
  }
  assert.equal((await app.inject({ method: 'POST', url: '/admin/x', headers: sameOrigin })).statusCode, 404)
})

test('without a web build, page paths get a JSON 404', async (t) => {
  const { app } = await buildTestApp()
  t.after(() => app.close())
  const res = await app.inject({ method: 'GET', url: '/admin' })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.json(), { error: 'not_found' })
})
