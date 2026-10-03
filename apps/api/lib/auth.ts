// Who is calling, and the guards protected routes put in front of their
// handler (`preHandler: requireSession` or `onRequest: requireGlobalRole('teacher')`;
// election routes use requireElectionAccess in election-access.ts).
//
// Status codes for refused requests, the same on every route:
//
//   401  no valid admin session: signed out, expired, or a cookie that does
//        not decrypt;
//   403  signed in, but neither the global role nor the role in this
//        election allows the action;
//   404  not a member of the election: to the caller it does not exist, so
//        guessing ids reveals nothing (election routes);
//   409  allowed, but not in the election's current state.

import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify'
import { ADMIN_SESSION_SECONDS, type SessionUser } from '../plugins/session.ts'

/**
 * Global roles come from the app-role claim of the ID token, through this
 * allow-list; any other value is dropped. Teachers may create elections.
 * Signing in without a role is fine: witnesses are students, and their
 * rights come from the elections they are members of. There is no global
 * admin role: no one sees another teacher's elections by role alone.
 */
export const GLOBAL_ROLES = ['teacher'] as const
export type GlobalRole = typeof GLOBAL_ROLES[number]

export function isGlobalRole(value: unknown): value is GlobalRole {
  return GLOBAL_ROLES.includes(value as GlobalRole)
}

/** The signed-in caller, or undefined. A session past its lifetime, or without a sign-in time, counts as none. */
export function currentUser(request: FastifyRequest, now = Date.now()): SessionUser | undefined {
  const user = request.adminSession.get('user')
  if (!user || !withinSeconds(user.issuedAt, ADMIN_SESSION_SECONDS, now)) return undefined
  return user
}

/** Whether `since` (a Date.now() value) lies less than `seconds` back; false for anything that is not a time. */
export function withinSeconds(since: unknown, seconds: number, now = Date.now()): boolean {
  if (typeof since !== 'number' || !Number.isFinite(since)) return false
  return now - since < seconds * 1000
}

// The caller a guard let through, per request. The handler works with this
// snapshot: reading the session and the clock again could find the
// session expired a moment later, and fail a request already authorized.
const authorized = new WeakMap<FastifyRequest, SessionUser>()

/** For handlers behind a guard: the caller it authorized. */
export function callerOf(request: FastifyRequest): SessionUser {
  const user = authorized.get(request)
  if (!user) throw new Error('callerOf() used on a route without a guard')
  return user
}

// A guard that replies does not call done(), so Fastify stops before the handler.

/**
 * For guards: the signed-in caller, recorded as the one callerOf() returns
 * for this request, or undefined without a session.
 */
export function authenticate(request: FastifyRequest): SessionUser | undefined {
  const user = currentUser(request)
  if (user) authorized.set(request, user)
  return user
}

export function requireSession(request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
  if (!authenticate(request)) {
    void reply.code(401).send({ error: 'unauthenticated' })
    return
  }
  done()
}

export function requireGlobalRole(role: GlobalRole) {
  return (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    const user = currentUser(request)
    if (!user) {
      void reply.code(401).send({ error: 'unauthenticated' })
      return
    }
    if (!user.roles.includes(role)) {
      void reply.code(403).send({ error: 'forbidden' })
      return
    }
    authorized.set(request, user)
    done()
  }
}
