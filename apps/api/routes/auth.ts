// Sign-in for teachers and witnesses, and the admin session it starts.
// Voters never come here.
//
//   GET  /api/auth/login?returnTo=/path  start sign-in at Entra
//   GET  /api/auth/callback              Entra sends the browser back here
//   POST /api/auth/logout
//   GET  /api/auth/me                   who is signed in; 204 when nobody is
//
// The callback is the one GET that changes state: it records the person,
// binds the election invitations sent to their address, and starts the
// session. It has to be a GET, because Entra returns the browser
// with a top-level redirect that carries the code in the query. A forged or
// replayed callback gets nowhere: the state must match the state cookie, the
// code is redeemed only with the client secret, and the ID token must carry
// the nonce from the sealed session; state and nonce are set in this browser
// by the login that started this sign-in, and used once.

import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { Type, type Static } from 'typebox'
import type { Config } from '../config.ts'
import { upsertAppUser } from '../lib/app-user.ts'
import { authenticate, GLOBAL_ROLES, withinSeconds } from '../lib/auth.ts'
import type { Database } from '../lib/db.ts'
import { registerEntra, SIGN_IN_SECONDS, SignInError } from '../lib/entra.ts'
import { bindInvitations } from '../lib/members.ts'
import { safeReturnTo } from '../lib/return-to.ts'
import { ErrorResponse, StrictObject } from '../lib/schemas/common.ts'

export interface AuthRoutesOptions {
  config: Config
  db: Database
  /** Where Entra is reached; only tests set it. */
  entraAuthority?: string
}

// Not strict: when single sign-on cannot complete silently, Entra sends the
// browser back here with sso_reload=true, and possibly parameters of its own.
// Only these are read.
const LoginQuery = Type.Object({
  returnTo: Type.Optional(Type.String({ maxLength: 2048 })),
  sso_reload: Type.Optional(Type.String({ maxLength: 64 })),
})

// Not strict: Entra adds parameters of its own (session_state, iss, ...).
// Only these are read.
const CallbackQuery = Type.Object({
  code: Type.Optional(Type.String({ maxLength: 8192 })),
  state: Type.Optional(Type.String({ maxLength: 512 })),
  error: Type.Optional(Type.String({ maxLength: 512 })),
})

const MeResponse = StrictObject({
  id: Type.String(),
  displayName: Type.String(),
  roles: Type.Array(Type.Union(GLOBAL_ROLES.map((role) => Type.Literal(role)))),
})

// Starting and completing a sign-in is limited per client address: generous
// enough for a staff room behind one NAT address, tight enough that nobody
// can make this server send Entra a token request per request they send.
// Only the routes that set this are limited; the plugin logs nothing.
const SIGN_IN_RATE_LIMIT = { max: 60, timeWindow: 60_000 }

export async function authRoutes(app: FastifyInstance, { config, db, entraAuthority }: AuthRoutesOptions): Promise<void> {
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => Object.assign(new Error('rate limited'), { statusCode: context.statusCode, code: 'rate_limited' }),
  })
  const entra = await registerEntra(app, config.entra, `${config.publicOrigin}/api/auth/callback`, entraAuthority)

  // Sets the state cookie and the pending sign-in; changes nothing on the
  // server. After an sso_reload the same URL would fail silently again, so
  // that retry asks for the interactive sign-in page once.
  app.get<{ Querystring: Static<typeof LoginQuery> }>('/api/auth/login', {
    exposeHeadRoute: false,
    config: { rateLimit: SIGN_IN_RATE_LIMIT },
    schema: { querystring: LoginQuery, response: { '4xx': ErrorResponse } },
  }, async (request, reply) => {
    const nonce = randomBytes(32).toString('base64url')
    request.adminSession.set('signIn', { nonce, returnTo: safeReturnTo(request.query.returnTo), startedAt: Date.now() })
    const interactive = request.query.sso_reload === 'true'
    return reply.redirect(await entra.authorizationUrl(request, reply, nonce, interactive), 302)
  })

  app.get<{ Querystring: Static<typeof CallbackQuery> }>('/api/auth/callback', {
    exposeHeadRoute: false,
    config: { rateLimit: SIGN_IN_RATE_LIMIT },
    schema: { querystring: CallbackQuery, response: { '4xx': ErrorResponse } },
  }, async (request, reply) => {
    // Only the callback of this browser's own sign-in may use it up. The
    // session cookie is Lax, so another site can send the browser here, and
    // that must not cancel a sign-in in progress. Entra returns the state
    // with an error too, so only a callback without it is turned away here.
    if (!entra.stateMatches(request, request.query.state)) {
      return refuse(request, reply, new SignInError('state_mismatch'))
    }
    const session = request.adminSession
    const pending = session.get('signIn')
    if (pending) session.set('signIn', undefined)
    if (!pending || !withinSeconds(pending.startedAt, SIGN_IN_SECONDS)) {
      return refuse(request, reply, new SignInError('no_pending_sign_in'))
    }
    let signIn
    try {
      // Entra reports a cancelled or refused sign-in as ?error=.
      if (request.query.error !== undefined || request.query.code === undefined) throw new SignInError('no_code')
      signIn = await entra.verifyIdToken(await entra.exchangeCode(request, reply), pending.nonce)
    } catch (err) {
      return refuse(request, reply, err)
    }
    // The person is recorded, and invitations to their address are bound
    // to them, in one transaction with the audit events of the bindings.
    const id = await db.tx(async (client) => {
      const userId = await upsertAppUser(client, signIn)
      await bindInvitations(client, userId, signIn, config.entra.tenantId)
      return userId
    })
    session.set('user', { id, displayName: signIn.displayName, roles: signIn.roles, issuedAt: Date.now() })
    // Checked at login and sealed since; checked again all the same.
    return reply.redirect(safeReturnTo(pending.returnTo), 303)
  })

  app.post('/api/auth/logout', (request, reply) => {
    request.adminSession.delete()
    void reply.code(204).send()
  })

  // The app's shell asks this on every page. Nobody signed in is an answer
  // (204), not a refusal: a browser logs every error status it gets, and a
  // signed-out visit is not an error.
  app.get('/api/auth/me', {
    schema: { response: { '200': MeResponse, '4xx': ErrorResponse } },
  }, (request, reply) => {
    const user = authenticate(request)
    if (!user) return reply.code(204).send()
    return { id: user.id, displayName: user.displayName, roles: user.roles }
  })
}

// The log line says why, by error type and code; never a token, a claim or
// the message of a library error.
function refuse(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  request.log.warn({ err }, 'sign-in refused')
  return reply.code(401).send({ error: 'sign_in_failed' })
}
