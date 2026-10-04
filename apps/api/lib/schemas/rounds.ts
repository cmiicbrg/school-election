// Request and response schemas of the round routes. The result and the
// outcome in a snapshot are election-core's data as stored, derived from
// the configuration and the anonymous ballots alone, and pass as they are.

import { Type } from 'typebox'
import { ELECTION_STATES, OUTCOME_KINDS, ROUND_STATES } from '@school-election/election-core'
import { Literals, StrictObject } from './common.ts'

export const RoundStates = StrictObject({
  election: Literals(ELECTION_STATES),
  round: Literals(ROUND_STATES),
})

export const RoundClosed = StrictObject({
  election: Literals(ELECTION_STATES),
  round: Literals(ROUND_STATES),
  /** Ballots sealed, over every contest of the round. */
  ballots: Type.Integer(),
  contests: Type.Array(StrictObject({
    contestId: Type.String(),
    outcome: Literals(OUTCOME_KINDS),
  })),
})

export const TestEnded = StrictObject({
  election: Literals(ELECTION_STATES),
  round: Literals(ROUND_STATES),
  /** Ballots the test had staged, all removed. */
  ballots: Type.Integer(),
  /** Keys that voted in the test, every entitlement of theirs unused again. */
  keys: Type.Integer(),
})

const Counts = {
  issued: Type.Integer(),
  used: Type.Integer(),
}

export const Turnout = StrictObject({
  round: Type.Union([Literals(ROUND_STATES), Type.Null()]),
  keys: StrictObject(Counts),
  contests: Type.Array(StrictObject({ contestId: Type.String(), ...Counts })),
})

export const RoundResults = StrictObject({
  round: Literals(ROUND_STATES),
  contests: Type.Array(StrictObject({
    contestId: Type.String(),
    inputSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    tallyVersion: Type.Integer(),
    appVersion: Type.String(),
    gitSha: Type.String(),
    result: Type.Unknown(),
    outcome: Type.Unknown(),
  })),
})
