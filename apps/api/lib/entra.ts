// Sign-in with Microsoft Entra ID for one tenant, as a confidential client:
// the authorization code flow with state and nonce. @fastify/oauth2 builds
// the authorization URL, keeps the state in a short-lived __Host- cookie,
// checks it and exchanges the code. jose then verifies the ID token against
// the tenant's signing keys, and the claims are checked here, failing
// closed. Nothing contacts Entra before the first sign-in: the keys are
// fetched on first use and cached.
//
// No PKCE, by decision: the client is confidential, so an intercepted code
// is worth nothing without the client secret, and the nonce ties the ID
// token to the browser that started the sign-in, so a code injected into
// another browser's callback is refused.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import oauth2, { type OAuth2Namespace } from '@fastify/oauth2'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { GUID, type EntraConfig } from '../config.ts'
import type { EntraIdentity } from './app-user.ts'
import { isGlobalRole, type GlobalRole } from './auth.ts'

export const ENTRA_AUTHORITY = 'https://login.microsoftonline.com'
/** Holds the state of a started sign-in until its callback. */
export const STATE_COOKIE = '__Host-oauth2-redirect-state'
/** How long a started sign-in may take. */
export const SIGN_IN_SECONDS = 10 * 60

export interface VerifiedSignIn extends EntraIdentity {
  roles: GlobalRole[]
}

export interface EntraClient {
  /**
   * The URL to send the browser to; sets the state cookie on the reply.
   * `interactive` asks Entra for the sign-in page instead of single sign-on.
   */
  authorizationUrl: (request: FastifyRequest, reply: FastifyReply, nonce: string, interactive: boolean) => Promise<string>
  /** Whether a callback carries the state of the sign-in this browser started. */
  stateMatches: (request: FastifyRequest, state: string | undefined) => boolean
  /** Checks the state, redeems the code, clears the state cookie; returns the ID token. */
  exchangeCode: (request: FastifyRequest, reply: FastifyReply) => Promise<string>
  verifyIdToken: (idToken: string, nonce: string) => Promise<VerifiedSignIn>
}

/** A refused sign-in; `code` says why and is safe to log. */
export class SignInError extends Error {
  override name = 'SignInError'
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

/**
 * Registers the OAuth client on `app` (an encapsulated instance: only the
 * sign-in routes see it). `authority` is where Entra is reached; tests point
 * it at a local stand-in. The expected issuer is Entra's in every case.
 */
export async function registerEntra(app: FastifyInstance, config: EntraConfig, redirectUri: string, authority = ENTRA_AUTHORITY): Promise<EntraClient> {
  const tenant = `/${config.tenantId}`
  await app.register(oauth2, {
    name: 'entra',
    // openid for the ID token, email and profile for the address and the
    // name. No API scope: the access token is never used, and no token is
    // kept after sign-in.
    scope: ['openid', 'email', 'profile'],
    credentials: {
      client: { id: config.clientId, secret: config.clientSecret },
      auth: {
        authorizeHost: authority,
        authorizePath: `${tenant}/oauth2/v2.0/authorize`,
        tokenHost: authority,
        tokenPath: `${tenant}/oauth2/v2.0/token`,
      },
      // A token endpoint that does not answer must not hold the callback.
      http: { timeout: 10_000 },
    },
    callbackUri: redirectUri,
    redirectStateCookieName: STATE_COOKIE,
    hostPrefixedCookies: true,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: SIGN_IN_SECONDS },
  })
  const client = app.getDecorator<OAuth2Namespace>('entra')
  const keys = createRemoteJWKSet(new URL(`${authority}${tenant}/discovery/v2.0/keys`))
  const issuer = `${ENTRA_AUTHORITY}${tenant}/v2.0`

  return {
    async authorizationUrl(request, reply, nonce, interactive) {
      const url = new URL(await client.generateAuthorizationUri(request, reply))
      url.searchParams.set('nonce', nonce)
      if (interactive) url.searchParams.set('prompt', 'login')
      return url.toString()
    },
    // The comparison the code exchange makes again: the cookie as the login
    // set it, against the state Entra sent back.
    stateMatches(request, state) {
      const expected = request.cookies[STATE_COOKIE]
      return expected !== undefined && expected !== '' && state === expected
    },
    async exchangeCode(request, reply) {
      let idToken: unknown
      try {
        idToken = (await client.getAccessTokenFromAuthorizationCodeFlow(request, reply)).token.id_token
      } catch (err) {
        throw new SignInError(exchangeFailure(err))
      }
      if (typeof idToken !== 'string') throw new SignInError('no_id_token')
      return idToken
    },
    async verifyIdToken(idToken, nonce) {
      // Signature by a current tenant key, issuer, audience, expiry.
      const { payload } = await jwtVerify(idToken, keys, {
        issuer,
        audience: config.clientId,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'nonce', 'tid', 'oid'],
        clockTolerance: 60,
      })
      if (payload.tid !== config.tenantId) throw new SignInError('wrong_tenant')
      if (payload.nonce !== nonce) throw new SignInError('wrong_nonce')
      const oid = typeof payload.oid === 'string' ? payload.oid.toLowerCase() : ''
      if (!GUID.test(oid)) throw new SignInError('no_oid')
      const roles = Array.isArray(payload.roles) ? payload.roles.filter(isGlobalRole) : []
      return {
        tid: config.tenantId,
        oid,
        displayName: text(payload.name) ?? text(payload.preferred_username) ?? oid,
        email: text(payload.email) ?? text(payload.preferred_username) ?? null,
        roles: [...new Set(roles)],
      }
    },
  }
}

// What an operator needs to tell a forged or stale callback from a broken
// app registration or an unreachable Entra. @fastify/oauth2 reports a state
// that does not match its cookie with exactly the error "Invalid state".
// The HTTP client fails with a Boom error; an answer from the token
// endpoint carries an OAuth error code (such as invalid_client for a wrong
// secret), a fixed vocabulary that is safe to log, unlike
// `error_description`. Anything else is a failed token request.
function exchangeFailure(err: unknown): string {
  if (err instanceof Error && err.message === 'Invalid state' && !('isBoom' in err)) return 'state_mismatch'
  const code = (err as { data?: { payload?: { error?: unknown } } } | null)?.data?.payload?.error
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? `token_request_${code}` : 'token_request_failed'
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
