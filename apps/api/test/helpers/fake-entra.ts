// A stand-in for Entra ID on a local port: the tenant's signing keys and
// its token endpoint, so sign-in runs end to end without a real tenant. The
// token endpoint insists on what Entra insists on and the app must get
// right: client authentication, the registered redirect URI and a code used
// once. For a real browser (the Playwright journeys) it also has the
// authorize page: a form that lists the test personas and sends the
// browser back to the app's callback with a code and the state, as Entra
// would after the person signed in.

import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { CLIENT_ID, CLIENT_SECRET, TENANT_ID } from './env.ts'
import { claimsOf, PERSONAS } from './personas.ts'

export const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`

/** Claims to change; `undefined` removes one. */
export type ClaimChanges = Record<string, unknown>

export interface AuthorizeOptions {
  claims?: ClaimChanges
  /** tenant: the published key; foreign: another key under the same kid; hs256: the client secret as an HMAC key. */
  signWith?: 'tenant' | 'foreign' | 'hs256'
}

export interface FakeEntra {
  authority: string
  /** Every request it answered, as "METHOD path". */
  requests: string[]
  /** Every token it handed out, ID and access tokens alike. */
  issued: string[]
  /**
   * Plays the user signing in at `authorizationUrl` (the Location of
   * /api/auth/login) and returns the callback path Entra would send the
   * browser to.
   */
  authorize: (authorizationUrl: string, options?: AuthorizeOptions) => string
  close: () => Promise<void>
}

interface PendingCode {
  redirectUri: string
  claims: Record<string, unknown>
  signWith: NonNullable<AuthorizeOptions['signWith']>
}

export async function startFakeEntra(): Promise<FakeEntra> {
  const kid = 'test-key'
  const tenantKey = await generateKeyPair('RS256')
  const foreignKey = await generateKeyPair('RS256')
  const jwks = { keys: [{ ...await exportJWK(tenantKey.publicKey), kid, alg: 'RS256', use: 'sig' }] }
  const codes = new Map<string, PendingCode>()
  const requests: string[] = []
  const issued: string[] = []

  function sign(code: PendingCode): Promise<string> {
    if (code.signWith === 'hs256') {
      return new SignJWT(code.claims).setProtectedHeader({ alg: 'HS256', kid }).sign(new TextEncoder().encode(CLIENT_SECRET))
    }
    const key = code.signWith === 'foreign' ? foreignKey.privateKey : tenantKey.privateKey
    return new SignJWT(code.claims).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).sign(key)
  }

  async function token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = new URLSearchParams(await readBody(request))
    const code = codes.get(body.get('code') ?? '')
    codes.delete(body.get('code') ?? '')
    const valid = code !== undefined
      && request.headers.authorization === basic(CLIENT_ID, CLIENT_SECRET)
      && body.get('grant_type') === 'authorization_code'
      && body.get('redirect_uri') === code.redirectUri
    if (!valid) return json(response, 400, { error: 'invalid_grant' })
    const tokens = { access_token: `access-${randomBytes(24).toString('base64url')}`, id_token: await sign(code) }
    issued.push(tokens.access_token, tokens.id_token)
    json(response, 200, { token_type: 'Bearer', expires_in: 3600, ...tokens })
  }

  let authority = ''

  /** Plays the sign-in for an authorization request: a code for the claims, and where the browser goes with it. */
  function issue(authorizationUrl: string, { claims = {}, signWith = 'tenant' }: AuthorizeOptions): { redirectUri: string, query: string } {
    const url = new URL(authorizationUrl)
    const param = (name: string) => url.searchParams.get(name) ?? ''
    if (url.origin !== authority || url.pathname !== `/${TENANT_ID}/oauth2/v2.0/authorize`
      || param('client_id') !== CLIENT_ID || param('response_type') !== 'code') {
      throw new Error(`not an authorization request for this tenant: ${authorizationUrl}`)
    }
    const now = Math.floor(Date.now() / 1000)
    const merged: Record<string, unknown> = {
      iss: ISSUER,
      aud: CLIENT_ID,
      tid: TENANT_ID,
      oid: 'c0ffee00-1234-4abc-8def-0123456789ab',
      name: 'Maria Muster',
      email: 'maria.muster@schule.example.org',
      preferred_username: 'maria.muster@schule.example.org',
      roles: ['teacher'],
      nonce: param('nonce'),
      iat: now,
      nbf: now,
      exp: now + 3600,
      ...claims,
    }
    const code = randomBytes(24).toString('base64url')
    codes.set(code, {
      redirectUri: param('redirect_uri'),
      claims: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)),
      signWith,
    })
    return { redirectUri: param('redirect_uri'), query: new URLSearchParams({ code, state: param('state'), session_state: randomUUID() }).toString() }
  }

  // The authorize page for a real browser: without a persona, the form;
  // with one, the sign-in of that persona and the way back to the app.
  function authorizePage(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', authority)
    const chosen = url.searchParams.get('persona')
    if (chosen === null) return html(response, 200, chooser(url))
    const person = PERSONAS.find((persona) => persona.oid === chosen)
    if (!person) return json(response, 404, { error: 'unknown_persona' })
    url.searchParams.delete('persona')
    try {
      const { redirectUri, query } = issue(url.toString(), { claims: claimsOf(person) })
      response.writeHead(302, { location: `${redirectUri}?${query}` }).end()
    } catch {
      json(response, 400, { error: 'invalid_request' })
    }
  }

  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (request.method === 'GET' && request.url === `/${TENANT_ID}/discovery/v2.0/keys`) return json(response, 200, jwks)
    if (request.method === 'GET' && pathname === `/${TENANT_ID}/oauth2/v2.0/authorize`) return authorizePage(request, response)
    if (request.method === 'POST' && request.url === `/${TENANT_ID}/oauth2/v2.0/token`) {
      token(request, response).catch(() => json(response, 500, { error: 'server_error' }))
      return
    }
    json(response, 404, { error: 'not_found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  authority = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    authority,
    requests,
    issued,
    authorize(authorizationUrl, options = {}) {
      return `/api/auth/callback?${issue(authorizationUrl, options).query}`
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** The sign-in page of the stand-in: every parameter of the request kept, and one button per persona. */
function chooser(url: URL): string {
  const hidden = [...url.searchParams]
    .map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`)
    .join('\n')
  const buttons = PERSONAS
    .map((person) => `<button type="submit" name="persona" value="${escape(person.oid)}">${escape(person.name)}</button>`)
    .join('\n')
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Anmeldung (Test)</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{display:block;margin:.5rem 0;padding:.5rem 1rem;font:inherit}</style>
</head><body>
<h1>Anmeldung (Test)</h1>
<p>Ein Stand-in für Microsoft Entra ID, nur für Tests. Als wer möchten Sie sich anmelden?</p>
<form method="get" action="${escape(url.pathname)}">
${hidden}
${buttons}
</form>
</body></html>`
}

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** The Authorization header of a client using client_secret_basic (RFC 6749, appendix B encoding). */
function basic(id: string, secret: string): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + (c.codePointAt(0) ?? 0).toString(16).toUpperCase())
  const credentials = Buffer.from(encode(id) + ':' + encode(secret)).toString('base64')
  return `Basic ${credentials}`
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString()
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body)
}

/** Cookies as a browser keeps them across inject() calls. */
export class CookieJar {
  readonly values = new Map<string, string>()

  update(response: { cookies: Array<{ name: string, value: string, maxAge?: number, expires?: Date }> }): void {
    for (const cookie of response.cookies) {
      const expired = cookie.maxAge === 0 || (cookie.expires !== undefined && cookie.expires.getTime() <= Date.now())
      if (expired || cookie.value === '') this.values.delete(cookie.name)
      else this.values.set(cookie.name, cookie.value)
    }
  }

  /** The Cookie header; values are kept decoded, as inject() reports them. */
  header(): string {
    return [...this.values].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ')
  }
}
