// Who is calling, and the guards protected routes put in front of their
// handler (`preHandler: requireSession` or `preHandler: requireGlobalRole('teacher')`).
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

import type { FastifyReply, FastifyRequest } from 'fastify'
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

/** The signed-in caller, or undefined. A session past its lifetime counts as none. */
export function currentUser(request: FastifyRequest, now = Date.now()): SessionUser | undefined {
  const user = request.adminSession.get('user')
  if (!user || !(now - user.issuedAt < ADMIN_SESSION_SECONDS * 1000)) return undefined
  return user
}

/** For handlers behind requireSession: the caller, who is known to exist. */
export function callerOf(request: FastifyRequest): SessionUser {
  const user = currentUser(request)
  if (!user) throw new Error('callerOf() used on a route without requireSession')
  return user
}

// A guard that replies returns the reply, so Fastify stops before the handler.

export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (!currentUser(request)) return reply.code(401).send({ error: 'unauthenticated' })
  return undefined
}

export function requireGlobalRole(role: GlobalRole) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const user = currentUser(request)
    if (!user) return reply.code(401).send({ error: 'unauthenticated' })
    if (!user.roles.includes(role)) return reply.code(403).send({ error: 'forbidden' })
    return undefined
  }
}
