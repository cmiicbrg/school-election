// Request and response schemas of the voter routes. Every id travels in a
// body or a cookie, never in a path; the one path parameter names a
// picture by its content. Responses are allow-lists: a voter learns the
// election's title, their own contests with the candidates, and nothing
// of anyone else.

import { Type } from 'typebox'
import { KEY_LENGTH, RULESET_IDS } from '@school-election/election-core'
import { Literals, StrictObject, Uuid } from './common.ts'

/** What was typed or scanned: the key, with whatever spacing and case the person used. */
export const SessionBody = StrictObject({
  key: Type.String({ minLength: 1, maxLength: KEY_LENGTH * 3 }),
})

export const VoterCandidate = StrictObject({
  id: Type.String(),
  surname: Type.String(),
  givenName: Type.String(),
  /** The content hash of its picture, for the voter's picture route, or null. */
  picture: Type.Union([Type.String(), Type.Null()]),
})

export const VoterContest = StrictObject({
  id: Type.String(),
  /** The ballot box the key's ballot goes into. */
  roundContestId: Type.String(),
  title: Type.String(),
  rulesetId: Literals(RULESET_IDS),
  activeSlots: Type.Integer(),
  /** The key has voted here already. */
  done: Type.Boolean(),
  candidates: Type.Array(VoterCandidate),
})

export const VoterElection = StrictObject({
  title: Type.String(),
  /** The round the key votes in: the election, or the teacher's test. */
  round: Literals(['open', 'testing'] as const),
  contests: Type.Array(VoterContest),
  /** Contests the key has not voted in yet. */
  remaining: Type.Integer(),
})

const Ranking = StrictObject({
  kind: Type.Literal('ranking'),
  /** The ballot's slots from the top, a candidate or empty each. */
  ranking: Type.Array(Type.Union([Uuid, Type.Null()]), { maxItems: 6 }),
  /** The voter's say that an incomplete ranking is meant as an invalid vote. */
  confirmInvalid: Type.Optional(Type.Literal(true)),
})

const No = StrictObject({
  kind: Type.Literal('no'),
})

export const BallotBody = StrictObject({
  roundContestId: Uuid,
  ballot: Type.Union([Ranking, No]),
})

export const BallotCast = StrictObject({
  done: Type.Boolean(),
  remaining: Type.Integer(),
})

/** A refusal, with election-core's say about a ballot where that is the reason: positions and counts, never a candidate. */
export const VoterRefusal = StrictObject({
  error: Type.String(),
  message: Type.Optional(Type.String()),
  problem: Type.Optional(Type.Unknown()),
})
