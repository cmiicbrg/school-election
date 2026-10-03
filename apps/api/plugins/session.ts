// Sessions live in the cookie itself, sealed by @fastify/secure-session
// (libsodium secretbox: encrypted and authenticated). The server keeps no
// session table, and a tampered, truncated, expired or foreign cookie reads
// as no session at all.
//
// Each kind of session has its own cookie and its own key, derived from
// SESSION_KEY_FILE under its own label, so a cookie of one kind can never be
// read as the other:
//
//   adminSession  teachers and witnesses after Entra sign-in (below);
//   voterSession  added with the voter flow, as a second entry in the
//                 registration below with its own label. It carries a
//                 voting entitlement and never an Entra identity.
//
// Admin sign-out only drops the cookie in that browser; a copied cookie
// stays valid until it expires. The lifetime is therefore short and
// absolute, counted from sign-in.

import { hkdfSync } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import secureSession, { type Session } from '@fastify/secure-session'
import type { Config } from '../config.ts'
import type { GlobalRole } from '../lib/auth.ts'

export const ADMIN_SESSION_COOKIE = '__Host-admin-session'
/** A school day, however active the session is. */
export const ADMIN_SESSION_SECONDS = 8 * 60 * 60

/** Who signed in; set by the sign-in callback only. */
export interface SessionUser {
  /** app_user.id */
  id: string
  displayName: string
  roles: GlobalRole[]
  /** Date.now() at sign-in; the lifetime is counted from here. */
  issuedAt: number
}

/** Between GET /api/auth/login and the callback. */
export interface PendingSignIn {
  /** Must come back inside the ID token. */
  nonce: string
  returnTo: string
  startedAt: number
}

export interface AdminSessionData {
  user: SessionUser
  signIn: PendingSignIn
}

declare module 'fastify' {
  interface FastifyRequest {
    adminSession: Session<AdminSessionData>
  }
}

export async function registerSessions(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(secureSession, [{
    sessionName: 'adminSession',
    cookieName: ADMIN_SESSION_COOKIE,
    key: sessionKey(config.sessionSecret, 'school-election admin session v1'),
    expiry: ADMIN_SESSION_SECONDS,
    // __Host-: only this host, over https, for the whole site. Lax, not
    // Strict: the browser has to send it on the top-level navigation back
    // from Entra, which carries the pending sign-in. Cross-site writes are
    // refused by the fetch-metadata check, not by SameSite.
    cookie: { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: ADMIN_SESSION_SECONDS },
  }])
}

/** A 32-byte secretbox key for one kind of session. */
export function sessionKey(secret: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), label, 32))
}
