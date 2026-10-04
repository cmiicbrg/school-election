// Ending an election (lib/cleanup.ts, lib/finalize.ts): the clean-up of
// what the seals left in the data directory, outside any transaction, then
// the declaration in one. By the owner, with a reason, once the regular
// round has closed and while no round is open.
//
//   POST /api/elections/:id/finalize   { reason }: the outcome of every contest as declared, and the runoff batches voided

import type { FastifyInstance } from 'fastify'
import type { Static } from 'typebox'
import { canFinalize } from '@school-election/election-core'
import type { Config } from '../config.ts'
import { cleanUp } from '../lib/cleanup.ts'
import type { Database } from '../lib/db.ts'
import { changeElection, electionAccessOf, requireElectionAccess } from '../lib/election-access.ts'
import { finalizeElection } from '../lib/finalize.ts'
import { ErrorResponse } from '../lib/schemas/common.ts'
import { ElectionFinalized, FinalizeBody } from '../lib/schemas/finalize.ts'

export function finalizeRoutes(app: FastifyInstance, { db, config }: { db: Database, config: Config }, done: (err?: Error) => void): void {
  app.post<{ Body: Static<typeof FinalizeBody> }>('/api/elections/:id/finalize', {
    onRequest: requireElectionAccess(db, 'finalize', canFinalize),
    schema: { body: FinalizeBody, response: { '200': ElectionFinalized, '4xx': ErrorResponse } },
  }, async (request) => {
    const cleaned = await cleanUp(db, electionAccessOf(request).electionId)
    const finalized = await changeElection(db, request, (client, access) => finalizeElection(client, access, config.build, request.body.reason, cleaned))
    return { state: 'final' as const, ...finalized }
  })
  done()
}
