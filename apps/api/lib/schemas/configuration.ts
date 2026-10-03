// Request and response schemas of the configuration, picture and prepare
// routes. Responses are allow-lists, like every response schema here.

import { Type } from 'typebox'
import { ELECTION_STATES, RULESET_IDS } from '@school-election/election-core'
import { PICTURE_MAX_UPLOAD_BYTES } from '../pictures.ts'
import { Literals, MultiLineText, SingleLineText, StrictObject, Uuid } from './common.ts'

/** A given name may be empty: an option of a poll has a surname (its text) alone. */
const GivenName = Type.String({ maxLength: 100, pattern: String.raw`^[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}]*$` })

export const ElectionUpdateBody = Type.Object({
  title: Type.Optional(SingleLineText(200)),
  description: Type.Optional(MultiLineText(2000)),
}, { additionalProperties: false, minProperties: 1 })

export const ContestBody = StrictObject({
  title: SingleLineText(200),
  rulesetId: Literals(RULESET_IDS),
})

export const ContestUpdateBody = Type.Object({
  title: Type.Optional(SingleLineText(200)),
  rulesetId: Type.Optional(Literals(RULESET_IDS)),
}, { additionalProperties: false, minProperties: 1 })

export const CandidateBody = StrictObject({
  surname: SingleLineText(100),
  givenName: GivenName,
})

export const CandidateUpdateBody = Type.Object({
  surname: Type.Optional(SingleLineText(100)),
  givenName: Type.Optional(GivenName),
}, { additionalProperties: false, minProperties: 1 })

export const VoterGroupBody = StrictObject({
  name: SingleLineText(100),
})

export const VoterGroupContestsBody = StrictObject({
  contestIds: Type.Array(Uuid, { uniqueItems: true, maxItems: 200 }),
})

/** A picture as the browser sends it: the file's bytes, base64-encoded. */
export const PictureBody = StrictObject({
  data: Type.String({
    minLength: 4,
    maxLength: Math.ceil(PICTURE_MAX_UPLOAD_BYTES / 3) * 4,
    pattern: '^[A-Za-z0-9+/]+={0,2}$',
  }),
})

export const Candidate = StrictObject({
  id: Type.String(),
  surname: Type.String(),
  givenName: Type.String(),
  picture: Type.Union([Type.String(), Type.Null()]),
})

export const Contest = StrictObject({
  id: Type.String(),
  title: Type.String(),
  rulesetId: Literals(RULESET_IDS),
  activeSlots: Type.Integer(),
  candidates: Type.Array(Candidate),
})

export const VoterGroup = StrictObject({
  id: Type.String(),
  name: Type.String(),
  contestIds: Type.Array(Type.String()),
})

export const Configuration = StrictObject({
  contests: Type.Array(Contest),
  voterGroups: Type.Array(VoterGroup),
})

const Problem = Type.Union([
  StrictObject({ kind: Type.Literal('no-contests') }),
  StrictObject({ kind: Type.Literal('no-voter-groups') }),
  StrictObject({ kind: Type.Literal('contest-without-candidates'), contestId: Type.String() }),
  StrictObject({ kind: Type.Literal('contest-without-voter-groups'), contestId: Type.String() }),
  StrictObject({ kind: Type.Literal('voter-group-without-contests'), voterGroupId: Type.String() }),
])

const Warning = Type.Union([
  StrictObject({ kind: Type.Literal('no-co-admin') }),
  StrictObject({ kind: Type.Literal('too-few-witnesses'), witnesses: Type.Integer() }),
  StrictObject({ kind: Type.Literal('pending-invitations'), count: Type.Integer() }),
])

const Summary = StrictObject({
  voterGroups: Type.Array(StrictObject({
    id: Type.String(),
    name: Type.String(),
    contests: Type.Array(StrictObject({ id: Type.String(), title: Type.String() })),
  })),
  contests: Type.Array(StrictObject({
    id: Type.String(),
    title: Type.String(),
    rulesetId: Literals(RULESET_IDS),
    candidates: Type.Integer(),
    activeSlots: Type.Integer(),
  })),
})

export const Preparation = StrictObject({
  problems: Type.Array(Problem),
  warnings: Type.Array(Warning),
  summary: Summary,
})

export const Prepared = StrictObject({
  state: Literals(ELECTION_STATES),
  summary: Summary,
  warnings: Type.Array(Warning),
})

export const StateResponse = StrictObject({
  state: Literals(ELECTION_STATES),
})

/**
 * Preparing again after a return to draft voids the batches whose keys no
 * longer fit only when the body confirms it: with the ids of exactly the
 * batches that were shown, which a change in between makes a refusal
 * again, or with true, for a caller that has seen none. Preparing for
 * the first time needs no body.
 */
export const PrepareBody = Type.Union([
  // The body limit bounds the list; a cap of its own could stop a caller from confirming every stale batch.
  StrictObject({ confirmVoid: Type.Union([Type.Boolean(), Type.Array(Uuid, { uniqueItems: true })]) }),
  Type.Null(),
])

/**
 * A refusal: the lifecycle's or the guard's code, not_ready with what
 * blocks preparing, or void_required with the batches preparing would void.
 */
export const PrepareRefusal = StrictObject({
  error: Type.String(),
  message: Type.Optional(Type.String()),
  problems: Type.Optional(Type.Array(Problem)),
  batches: Type.Optional(Type.Array(StrictObject({ id: Type.String(), voterGroupId: Type.String(), keys: Type.Integer() }))),
})
