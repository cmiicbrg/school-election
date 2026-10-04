// The voter API as the page uses it: same-origin JSON with the browser's
// cookie, and every refusal a VoterError with the API's code and, for a
// key or a ballot, the problem the API names (a position or a count, never
// a candidate). Nothing of the members' client (lib/api.ts), whose 401
// sends the browser to the sign-in page: a voter's 401 is no_session, the
// page's own business, back to the code.

import type { RulesetId } from '@school-election/election-core'

export interface VoterCandidate {
  id: string
  surname: string
  givenName: string
  /** The content hash of the candidate's picture, or null. */
  picture: string | null
}

export interface VoterContest {
  id: string
  /** The ballot box the key's ballot goes into. */
  roundContestId: string
  title: string
  rulesetId: RulesetId
  activeSlots: number
  /** The key has voted here already. */
  done: boolean
  candidates: VoterCandidate[]
}

export interface VoterElection {
  title: string
  /** The election, or the teacher's test. */
  round: 'open' | 'testing'
  contests: VoterContest[]
  /** Contests the key has not voted in yet. */
  remaining: number
}

/** A ranking: the ballot's rows from the top, a candidate or nothing in each; the confirmation makes an incomplete one an invalid vote. */
export interface RankingBallot {
  kind: 'ranking'
  ranking: (string | null)[]
  confirmInvalid?: true
}

/** "Nein", which only a contest with a single candidate offers. */
export interface NoBallot {
  kind: 'no'
}

export type VoterBallot = RankingBallot | NoBallot

export interface BallotCast {
  /** The last of the key's ballots: the session is over. */
  done: boolean
  remaining: number
}

export class VoterError extends Error {
  override name = 'VoterError'
  readonly status: number
  readonly code: string
  readonly problem: unknown

  constructor(status: number, code: string, problem?: unknown) {
    super(code)
    this.status = status
    this.code = code
    this.problem = problem
  }
}

export function redeem(key: string): Promise<VoterElection> {
  return call<VoterElection>('POST', '/api/voter/session', { key })
}

export function contests(): Promise<VoterElection> {
  return call<VoterElection>('GET', '/api/voter/contests')
}

export function castBallot(roundContestId: string, ballot: VoterBallot): Promise<BallotCast> {
  return call<BallotCast>('POST', '/api/voter/ballot', { roundContestId, ballot })
}

export async function endSession(): Promise<void> {
  await call<undefined>('POST', '/api/voter/session/end')
}

/** A candidate's picture, by its content; the API serves it cacheable for good. */
export function pictureUrl(sha256: string): string {
  return `/api/voter/picture/${encodeURIComponent(sha256)}`
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw refusalOf(response.status, await response.json().catch(() => ({})))
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

/** The API's error body: its code and, where it says more, the problem. */
export function refusalOf(status: number, payload: unknown): VoterError {
  const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const code = typeof body.error === 'string' && body.error !== '' ? body.error : 'request_failed'
  return new VoterError(status, code, body.problem)
}
