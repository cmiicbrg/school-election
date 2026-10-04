// Request and response schemas of the lots route and the election's result.

import { Type } from 'typebox'
import { MultiLineText, StrictObject, Uuid } from './common.ts'
import { Snapshot } from './rounds.ts'

/** The most candidates one lot can be drawn among: fifty ids, comma-separated, fit the event's long text. */
export const MAX_LOT_CANDIDATES = 50

export const LotBody = StrictObject({
  contestId: Uuid,
  /** The lot as election-core names it in the outcome. */
  lotId: Type.String({ minLength: 1, maxLength: 200 }),
  /** The tied set in the order drawn, in any case the ids come in; fifty is far beyond any school contest's tie, and what the event's text holds. */
  order: Type.Array(Uuid, { minItems: 2, maxItems: MAX_LOT_CANDIDATES }),
  reason: MultiLineText(500, 1),
})

export const LotRecorded = StrictObject({
  contestId: Type.String(),
  outcome: Type.Unknown(),
})

export const RecordedLot = StrictObject({
  id: Type.String(),
  lotId: Type.String(),
  candidates: Type.Array(Type.String()),
  drawn: Type.Array(Type.String()),
  reason: Type.String(),
  actorName: Type.String(),
  recordedAt: Type.String(),
})

/** Per contest: the first-round snapshot, the runoff's once it has closed, the recorded lots, and the outcome as it stands. */
export const ElectionResult = StrictObject({
  contests: Type.Array(StrictObject({
    contestId: Type.String(),
    first: Snapshot,
    runoff: Type.Union([Snapshot, Type.Null()]),
    lots: Type.Array(RecordedLot),
    outcome: Type.Unknown(),
  })),
})
