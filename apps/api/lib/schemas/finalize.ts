// Request and response schemas of finalizing an election.

import { Type } from 'typebox'
import { ELECTION_STATES, OUTCOME_KINDS } from '@school-election/election-core'
import { Literals, MultiLineText, StrictObject } from './common.ts'

export const FinalizeBody = StrictObject({
  /** Why the election ends now: the result was declared, or what went wrong. */
  reason: MultiLineText(2000, 1),
})

export const ElectionFinalized = StrictObject({
  state: Literals(ELECTION_STATES),
  /** Every contest with the kind of outcome declared for it. */
  contests: Type.Array(StrictObject({
    contestId: Type.String(),
    kind: Literals(OUTCOME_KINDS),
  })),
  /** Issued runoff batches voided, since no runoff was held. */
  batchesVoided: Type.Integer(),
})

/** When, by whom and why the election was finalized, from its event. */
export const Finalization = StrictObject({
  reason: Type.String(),
  actorName: Type.String(),
  at: Type.String(),
})
