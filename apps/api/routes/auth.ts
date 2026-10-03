// Sign-in for teachers and witnesses, and the admin session it starts.
// Voters never come here.
//
//   GET  /api/auth/login?returnTo=/path  start sign-in at Entra
//   GET  /api/auth/callback              Entra sends the browser back here
//   POST /api/auth/logout
//   GET  /api/auth/me
//
// The callback is the one GET that changes state: it records the person and
// starts the session. It has to be a GET, because Entra returns the browser
// with a top-level redirect that carries the code in the query. A forged or
// replayed callback gets nowhere: the state must match the state cookie, the
// code is redeemed only with the PKCE verifier from the verifier cookie, and
// the ID token must carry the nonce from the sealed session, all three set
// in this browser by the login that started this sign-in and used once.

import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Type, type Static } from 'typebox'
import type { Config } from '../config.ts'
import { upsertAppUser } from '../lib/app-user.ts'
import { callerOf, GLOBAL_ROLES, requireSession } from '../lib/auth.ts'
import type { Database } from '../lib/db.ts'
import { registerEntra, SIGN_IN_SECONDS, SignInError } from '../lib/entra.ts'
import { safeReturnTo } from '../lib/return-to.ts'
import { ErrorResponse, StrictObject } from '../lib/schemas/common.ts'

export interface AuthRoutesOptions {
  config: Config
  db: Database
  /** Where Entra is reached; only tests set it. */
  entraAuthority?: string
}

const LoginQuery = StrictObject({ returnTo: Type.Optional(Type.String({ maxLength: 2048 })) })

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

export async function authRoutes(app: FastifyInstance, { config, db, entraAuthority }: AuthRoutesOptions): Promise<void> {
  const entra = await registerEntra(app, config.entra, `${config.publicOrigin}/api/auth/callback`, entraAuthority)

  // Sets the state and verifier cookies and the pending sign-in; changes
  // nothing on the server.
  app.get<{ Querystring: Static<typeof LoginQuery> }>('/api/auth/login', {
    exposeHeadRoute: false,
    schema: { querystring: LoginQuery, response: { '4xx': ErrorResponse } },
  }, async (request, reply) => {
    const nonce = randomBytes(32).toString('base64url')
    request.adminSession.set('signIn', { nonce, returnTo: safeReturnTo(request.query.returnTo), startedAt: Date.now() })
    return reply.redirect(await entra.authorizationUrl(request, reply, nonce), 302)
  })

  app.get<{ Querystring: Static<typeof CallbackQuery> }>('/api/auth/callback', {
    exposeHeadRoute: false,
    schema: { querystring: CallbackQuery, response: { '4xx': ErrorResponse } },
  }, async (request, reply) => {
    const session = request.adminSession
    const pending = session.get('signIn')
    if (pending) session.set('signIn', undefined)
    if (!pending || !(Date.now() - pending.startedAt < SIGN_IN_SECONDS * 1000)) {
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
    const id = await upsertAppUser(db, signIn)
    session.set('user', { id, displayName: signIn.displayName, roles: signIn.roles, issuedAt: Date.now() })
    // Checked at login and sealed since; checked again all the same.
    return reply.redirect(safeReturnTo(pending.returnTo), 303)
  })

  app.post('/api/auth/logout', async (request, reply) => {
    request.adminSession.delete()
    return reply.code(204).send()
  })

  app.get('/api/auth/me', {
    preHandler: requireSession,
    schema: { response: { '200': MeResponse, '4xx': ErrorResponse } },
  }, async (request) => {
    const { id, displayName, roles } = callerOf(request)
    return { id, displayName, roles }
  })
}

// The log line says why, by error type and code; never a token, a claim or
// the message of a library error.
function refuse(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  request.log.warn({ err }, 'sign-in refused')
  return reply.code(401).send({ error: 'sign_in_failed' })
}
