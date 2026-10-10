// A stand-in for Entra ID on a local port: the tenant's signing keys and
// its token endpoint, so sign-in runs end to end without a real tenant. It
// insists on what Entra insists on and the app must get right: the
// registered redirect URI, client authentication and a code used once.
// For a real browser (the Playwright journeys, and development without a
// tenant: test/dev-server.ts) it also has the authorize page: a form that
// lists the test personas and takes any name and address typed in, keeps
// the request it answers on the server under a random id, and sends the
// browser back to the registered callback with a code and the state, as
// Entra would after the person signed in.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { CLIENT_ID, CLIENT_SECRET, ORIGIN, TENANT_ID } from './env.ts'
import { claimsOf, PERSONAS, type Person } from './personas.ts'

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

export interface FakeEntraOptions {
  /** The app's registered redirect URI; any other is refused, as Entra refuses it. */
  redirectUri?: string
}

export async function startFakeEntra({ redirectUri = `${ORIGIN}/api/auth/callback` }: FakeEntraOptions = {}): Promise<FakeEntra> {
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

  /** An authorization request of this tenant's registered client, or an error naming what is wrong. */
  function checked(authorizationUrl: string): URL {
    const url = new URL(authorizationUrl)
    const param = (name: string) => url.searchParams.get(name) ?? ''
    if (url.origin !== authority || url.pathname !== `/${TENANT_ID}/oauth2/v2.0/authorize`
      || param('client_id') !== CLIENT_ID || param('response_type') !== 'code' || param('redirect_uri') !== redirectUri) {
      throw new Error(`not an authorization request for this tenant and client: ${authorizationUrl}`)
    }
    return url
  }

  /** Plays the sign-in for an authorization request: a code for the claims, and the query the browser goes back with. */
  function issue(authorizationUrl: string, { claims = {}, signWith = 'tenant' }: AuthorizeOptions): { redirectUri: string, query: string } {
    const url = checked(authorizationUrl)
    const param = (name: string) => url.searchParams.get(name) ?? ''
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
      redirectUri,
      claims: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)),
      signWith,
    })
    return { redirectUri, query: new URLSearchParams({ code, state: param('state'), session_state: randomUUID() }).toString() }
  }

  // The authorize page for a real browser: the app's request is kept here
  // under a random id and the form carries only that id, so nothing of the
  // request is rendered; the persona chosen signs in for that request, and
  // the browser goes back to the registered callback.
  const pendingRequests = new Map<string, string>()

  function authorizePage(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', authority)
    const chosen = url.searchParams.get('persona')
    const typed = url.searchParams.get('email')
    if (chosen === null && typed === null) {
      try {
        checked(url.toString())
      } catch {
        return json(response, 400, { error: 'invalid_request' })
      }
      const id = randomBytes(12).toString('base64url')
      pendingRequests.set(id, url.toString())
      return html(response, 200, chooser(id))
    }
    const pending = pendingRequests.get(url.searchParams.get('request') ?? '')
    pendingRequests.delete(url.searchParams.get('request') ?? '')
    if (pending === undefined) return json(response, 400, { error: 'invalid_request' })
    const person = chosen === null
      ? typedPerson(typed ?? '', url.searchParams.get('name') ?? '', url.searchParams.has('teacher'))
      : PERSONAS.find((persona) => persona.oid === chosen)
    if (!person) return json(response, 404, { error: 'unknown_persona' })
    const { query } = issue(pending, { claims: claimsOf(person) })
    response.writeHead(302, { location: `${redirectUri}?${query}` }).end()
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
      return `${new URL(redirectUri).pathname}?${issue(authorizationUrl, options).query}`
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * A person typed into the sign-in page: the address and name as given, the
 * teacher role if ticked, and an object id derived from the address, so the
 * same address is the same person on every sign-in. Undefined without an
 * address.
 */
export function typedPerson(email: string, name: string, teacher: boolean): Person | undefined {
  const address = email.trim().toLowerCase()
  if (!address.includes('@')) return undefined
  const hex = createHash('sha256').update(address).digest('hex')
  const oid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  return { oid, name: name.trim() || address.split('@')[0] || address, email: address, roles: teacher ? ['teacher'] : [] }
}

/** The sign-in page of the stand-in: the pending request's id, one button per persona, and a form for anyone else. */
function chooser(requestId: string): string {
  const buttons = PERSONAS
    .map((person) => `<button type="submit" name="persona" value="${person.oid}">${person.name}</button>`)
    .join('\n')
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Anmeldung (Test)</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}button{display:block;margin:.5rem 0;padding:.5rem 1rem;font:inherit}label{display:block;margin:.5rem 0}input:not([type=checkbox]){display:block;width:100%;padding:.4rem;font:inherit;box-sizing:border-box}h2{font-size:1.1rem;margin-top:2rem}</style>
</head><body>
<h1>Anmeldung (Test)</h1>
<p>Ein Stand-in für Microsoft Entra ID, nur für Tests. Als wer möchten Sie sich anmelden?</p>
<form method="get" action="/${TENANT_ID}/oauth2/v2.0/authorize">
<input type="hidden" name="request" value="${requestId}">
${buttons}
</form>
<h2>Jemand anderes</h2>
<form method="get" action="/${TENANT_ID}/oauth2/v2.0/authorize">
<input type="hidden" name="request" value="${requestId}">
<label>Name <input name="name" autocomplete="off"></label>
<label>Schul-E-Mail-Adresse <input name="email" type="email" required autocomplete="off"></label>
<label><input name="teacher" type="checkbox" checked> Lehrkraft (darf Wahltermine anlegen)</label>
<button type="submit">Anmelden</button>
</form>
</body></html>`
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
