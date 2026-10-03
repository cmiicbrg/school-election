// A stand-in for Entra ID on a local port: the tenant's signing keys and
// its token endpoint, so sign-in runs end to end without a real tenant. The
// token endpoint insists on what Entra insists on and the app must get
// right: client authentication, the registered redirect URI, a code used
// once, and a PKCE verifier matching the challenge of the authorization
// request.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { CLIENT_ID, CLIENT_SECRET, TENANT_ID } from './env.ts'

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
  challenge: string
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
    const verifier = body.get('code_verifier') ?? ''
    const valid = code !== undefined
      && request.headers.authorization === basic(CLIENT_ID, CLIENT_SECRET)
      && body.get('grant_type') === 'authorization_code'
      && body.get('redirect_uri') === code.redirectUri
      && createHash('sha256').update(verifier).digest('base64url') === code.challenge
    if (!valid) return json(response, 400, { error: 'invalid_grant' })
    const tokens = { access_token: `access-${randomBytes(24).toString('base64url')}`, id_token: await sign(code) }
    issued.push(tokens.access_token, tokens.id_token)
    json(response, 200, { token_type: 'Bearer', expires_in: 3600, ...tokens })
  }

  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (request.method === 'GET' && request.url === `/${TENANT_ID}/discovery/v2.0/keys`) return json(response, 200, jwks)
    if (request.method === 'POST' && request.url === `/${TENANT_ID}/oauth2/v2.0/token`) {
      token(request, response).catch(() => json(response, 500, { error: 'server_error' }))
      return
    }
    json(response, 404, { error: 'not_found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const authority = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    authority,
    requests,
    issued,
    authorize(authorizationUrl, { claims = {}, signWith = 'tenant' } = {}) {
      const url = new URL(authorizationUrl)
      const param = (name: string) => url.searchParams.get(name) ?? ''
      if (url.origin !== authority || url.pathname !== `/${TENANT_ID}/oauth2/v2.0/authorize`
        || param('client_id') !== CLIENT_ID || param('response_type') !== 'code' || param('code_challenge_method') !== 'S256') {
        throw new Error(`not an authorization request for this tenant: ${authorizationUrl}`)
      }
      const now = Math.floor(Date.now() / 1000)
      const merged: Record<string, unknown> = {
        iss: ISSUER,
        aud: CLIENT_ID,
        tid: TENANT_ID,
        oid: 'c0ffee00-1234-4abc-8def-0123456789ab',
        name: 'Maria Muster',
        preferred_username: 'maria.muster@schule.example.org',
        upn: 'maria.muster@schule.example.org',
        roles: ['teacher'],
        nonce: param('nonce'),
        iat: now,
        nbf: now,
        exp: now + 3600,
        ...claims,
      }
      const code = randomBytes(24).toString('base64url')
      codes.set(code, {
        challenge: param('code_challenge'),
        redirectUri: param('redirect_uri'),
        claims: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)),
        signWith,
      })
      return `/api/auth/callback?${new URLSearchParams({ code, state: param('state'), session_state: randomUUID() }).toString()}`
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
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
