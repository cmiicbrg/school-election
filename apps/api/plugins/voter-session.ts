// The voter's session: a second sealed cookie of the same plugin as the
// admin session (plugins/session.ts), under its own key and name, so a
// cookie of one kind never reads as the other. It carries a voting
// entitlement, the key's credential and the round it votes in, in the
// phase it was redeemed in, never the key and never an identity, for
// twenty minutes from redemption, and no longer than that phase. It is
// registered in the voter scope alone, which the admin session's hook
// never reaches, and its path keeps the browser from sending it anywhere
// but the voter routes.

import type { FastifyInstance } from 'fastify'
import secureSession, { type Session } from '@fastify/secure-session'
import type { Config } from '../config.ts'
import type { VotingState } from '../lib/voter.ts'
import { sessionKey } from './session.ts'

export const VOTER_SESSION_COOKIE = '__Secure-voter-session'
export const VOTER_SESSION_PATH = '/api/voter'
/** Long enough to vote in every contest at a crowded table; short enough that a copied cookie is soon worthless. */
export const VOTER_SESSION_SECONDS = 20 * 60

export interface Voter {
  credentialId: string
  electionId: string
  roundId: string
  /** The round's state at redemption, for the answers. */
  round: VotingState
  /** The round's phase at redemption: the session ends with it, so a session from a test never votes in the election or in the next test. */
  phase: string
  /** Date.now() at redemption; the lifetime is counted from here. */
  issuedAt: number
}

export interface VoterSessionData {
  voter: Voter
}

declare module 'fastify' {
  interface FastifyRequest {
    voterSession: Session<VoterSessionData>
  }
}

export async function registerVoterSession(scope: FastifyInstance, config: Config): Promise<void> {
  await scope.register(secureSession, [{
    sessionName: 'voterSession',
    cookieName: VOTER_SESSION_COOKIE,
    key: sessionKey(config.sessionSecret, 'school-election voter session v1'),
    expiry: VOTER_SESSION_SECONDS,
    // Strict: the voter page is the only page that sends it, and it is
    // never carried on a navigation from elsewhere.
    cookie: { path: VOTER_SESSION_PATH, httpOnly: true, secure: true, sameSite: 'strict', maxAge: VOTER_SESSION_SECONDS },
  }])
}
