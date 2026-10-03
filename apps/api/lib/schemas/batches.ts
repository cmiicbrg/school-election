// Request and response schemas of the batch routes. Responses are
// allow-lists, like every response schema here: a key reaches a client in
// the one field declared for it, and nothing else of a credential's row.

import { Type } from 'typebox'
import { ROUND_KINDS } from '@school-election/election-core'
import { BATCH_STATES, MAX_BATCH_KEYS } from '../credentials.ts'
import { Literals, StrictObject, Uuid } from './common.ts'

export const IssueBatchBody = StrictObject({
  voterGroupId: Uuid,
  roundKind: Literals(ROUND_KINDS),
  count: Type.Integer({ minimum: 1, maximum: MAX_BATCH_KEYS }),
})

export const BatchSummary = StrictObject({
  id: Type.String(),
  voterGroupId: Type.String(),
  roundKind: Literals(ROUND_KINDS),
  state: Literals(BATCH_STATES),
  /** How many keys the batch holds. */
  keys: Type.Integer(),
})

export const BatchList = StrictObject({
  batches: Type.Array(BatchSummary),
})

/** A batch with its keys, normalised; `used` is known once the batch's round has closed, null before. */
export const BatchKeys = StrictObject({
  batch: BatchSummary,
  keys: Type.Array(StrictObject({
    key: Type.String({ pattern: '^[0-9A-HJKMNP-TV-Z]{20}$' }),
    used: Type.Union([Type.Boolean(), Type.Null()]),
  })),
})
