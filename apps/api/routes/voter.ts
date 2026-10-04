// The voter's routes: a scope of their own, with their own session and
// without the admin session's hook, so a voter request never carries an
// identity and an administrator's cookie is never read here. Every path
// is constant; ids travel in a body or in the cookie, and a session that
// works leaves no log line.
//
//   POST /api/voter/session         { key }: redeems the key, starts the session, answers the election
//   GET  /api/voter/contests        the election and the key's contests again
//   GET  /api/voter/picture/:sha256 a candidate's picture, by content
//   POST /api/voter/ballot          { roundContestId, ballot }: one ballot
//   POST /api/voter/session/end     ends the session

import { setTimeout as sleep } from 'node:timers/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Type, type Static } from 'typebox'
import { parseKey, validateBallot, type Contest, type RoundState } from '@school-election/election-core'
import type { Config } from '../config.ts'
import { AttemptLimiter } from '../lib/attempt-limiter.ts'
import { castBallot, type CastRefusal } from '../lib/ballot-box.ts'
import { readContest } from '../lib/configuration.ts'
import type { Database } from '../lib/db.ts'
import { Refusal } from '../lib/election-access.ts'
import { matchesEtag, pictureEtag } from '../lib/pictures.ts'
import { BallotBody, BallotCast, SessionBody, VoterElection, VoterRefusal } from '../lib/schemas/voter.ts'
import { entitledBox, lookUpKey, remainingBoxes, roundNow, voterElection, voterPicture, type Queryable, type VotingState } from '../lib/voter.ts'
import { registerVoterSession, VOTER_SESSION_SECONDS, type Voter } from '../plugins/voter-session.ts'

export interface VoterRoutesOptions {
  db: Database
  config: Config
  /** The limiter, or one with the defaults; tests pass one with a fake clock. */
  limiter?: AttemptLimiter
  /** How a failing answer waits; tests pass one that does not. */
  wait?: (ms: number) => Promise<unknown>
}

const PictureParams = Type.Object({ sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }) })
const IMMUTABLE = 'private, max-age=31536000, immutable'

const REFUSALS: Readonly<Record<CastRefusal, string>> = {
  'not-entitled': 'not_entitled',
  'already-voted': 'already_voted',
  'wrong-contest': 'not_entitled',
  'refused': 'round_closed',
}

/** What a session gets once its round has left the phase it was redeemed in: the lifecycle's answer, or none once the round moved on without it. */
const PHASE_OVER: Readonly<Partial<Record<RoundState, [number, string]>>> = {
  closed: [409, 'round_closed'],
  planned: [409, 'round_planned'],
}

/** The session's voter, or 401: no cookie, one that does not decode, or one older than its lifetime. */
function voterOf(request: FastifyRequest): Voter {
  const voter = request.voterSession.get('voter')
  if (!voter || Date.now() - voter.issuedAt > VOTER_SESSION_SECONDS * 1000) throw new Refusal(401, 'no_session')
  return voter
}

/**
 * The session holds while its round stays in the phase it was redeemed in, which the database renews
 * with every change of state. A round that closed, a test that ended, or a round opened or tested
 * again after that end the session, with the lifecycle's answer: a cookie from a test never casts a
 * ballot in the election or in the next test, and no session reports a round as open that is not.
 * The ballot route asks inside its transaction, the others before their read.
 */
async function stillVoting(client: Queryable, request: FastifyRequest, voter: Voter): Promise<void> {
  const now = await roundNow(client, voter.roundId)
  if (now?.phase === voter.phase) return
  request.voterSession.delete()
  const [statusCode, code] = (now && PHASE_OVER[now.state]) ?? [401, 'no_session']
  throw new Refusal(statusCode, code)
}

async function requireVoter(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  try {
    voterOf(request)
  } catch (err) {
    if (err instanceof Refusal) return reply.code(err.statusCode).send({ error: err.code })
    throw err
  }
  return undefined
}

export async function voterRoutes(app: FastifyInstance, { db, config, limiter = new AttemptLimiter(), wait = sleep }: VoterRoutesOptions): Promise<void> {
  await registerVoterSession(app, config)
  // Nothing below the warnings: a session that works is nobody's business.
  const quiet = { logLevel: 'warn' } as const

  app.post<{ Body: Static<typeof SessionBody> }>('/api/voter/session', {
    ...quiet,
    schema: { body: SessionBody, response: { '200': VoterElection, '4xx': VoterRefusal } },
  }, async (request, reply) => {
    const parsed = parseKey(request.body.key)
    if (!parsed.ok) return reply.code(400).send({ error: 'invalid_key', problem: parsed.problem })
    const found = await lookUpKey(db, parsed.key)
    if (!found) {
      // An unknown key, or a void batch's: one answer for both, after the limiter's say.
      const verdict = limiter.begin(request.ip)
      if (verdict === 'refused') return reply.code(429).send({ error: 'rate_limited' })
      try {
        await wait(verdict.delayMs)
        return await reply.code(404).send({ error: 'unknown_key' })
      } finally {
        limiter.end(request.ip)
      }
    }
    if (found.roundId === null || found.phase === null || !found.acceptsBallots) {
      return reply.code(409).send({ error: found.roundState === 'closed' ? 'round_closed' : 'round_planned' })
    }
    const round: VotingState = found.roundState === 'testing' ? 'testing' : 'open'
    request.voterSession.set('voter', { credentialId: found.credentialId, electionId: found.electionId, roundId: found.roundId, round, phase: found.phase, issuedAt: Date.now() })
    return voterElection(db, found.credentialId, found.roundId, round)
  })

  app.get('/api/voter/contests', {
    ...quiet,
    onRequest: requireVoter,
    schema: { response: { '200': VoterElection, '4xx': VoterRefusal } },
  }, async (request) => {
    const voter = voterOf(request)
    await stillVoting(db, request, voter)
    return voterElection(db, voter.credentialId, voter.roundId, voter.round)
  })

  app.get<{ Params: Static<typeof PictureParams> }>('/api/voter/picture/:sha256', {
    ...quiet,
    onRequest: requireVoter,
    config: { contentAddressed: true },
    schema: { params: PictureParams, response: { '4xx': VoterRefusal } },
  }, async (request, reply) => {
    const voter = voterOf(request)
    await stillVoting(db, request, voter)
    const { sha256 } = request.params
    const revalidating = matchesEtag(request.headers['if-none-match'], sha256)
    const row = await voterPicture(db, voter.credentialId, voter.roundId, sha256, !revalidating)
    if (!row) throw new Refusal(404, 'not_found')
    void reply.header('etag', pictureEtag(sha256)).header('cache-control', IMMUTABLE)
    if (revalidating) return reply.code(304).send()
    return reply.type('image/webp').send(row.picture)
  })

  app.post<{ Body: Static<typeof BallotBody> }>('/api/voter/ballot', {
    ...quiet,
    onRequest: requireVoter,
    schema: { body: BallotBody, response: { '200': BallotCast, '4xx': VoterRefusal } },
  }, async (request, reply) => {
    const voter = voterOf(request)
    const { roundContestId, ballot } = request.body
    const outcome = await db.tx(async (client) => {
      await stillVoting(client, request, voter)
      const box = await entitledBox(client, voter.credentialId, voter.roundId, roundContestId)
      if (!box) throw new Refusal(409, 'not_entitled')
      const stored = await readContest(client, box.electionId, box.contestId)
      const contest: Contest = { id: stored.id, rulesetId: stored.rulesetId, candidateIds: stored.candidates.map((candidate) => candidate.id) }
      const validated = validateBallot(contest, ballot)
      if (!validated.ok) return { invalid: validated.error }
      const result = await castBallot(client, { credentialId: voter.credentialId, roundContestId, contest, ballot: validated.ballot })
      if (!result.cast) throw new Refusal(409, REFUSALS[result.reason])
      const remaining = await remainingBoxes(client, voter.credentialId, voter.roundId)
      return { remaining }
    })
    if ('invalid' in outcome) return reply.code(400).send({ error: 'invalid_ballot', problem: outcome.invalid })
    // The last ballot ends the session: the cookie goes with the answer.
    if (outcome.remaining === 0) request.voterSession.delete()
    return { done: outcome.remaining === 0, remaining: outcome.remaining }
  })

  app.post('/api/voter/session/end', {
    ...quiet,
    schema: { response: { '4xx': VoterRefusal } },
  }, async (request, reply) => {
    request.voterSession.delete()
    return reply.code(204).send()
  })
}
