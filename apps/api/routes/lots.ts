// Recording a lot the officials drew (lib/lots.ts).
//
//   POST /api/elections/:id/lots   { contestId, lotId, order, reason }: the lot's outcome, once; answers the contest's outcome as it stands now

import type { FastifyInstance } from 'fastify'
import type { Static } from 'typebox'
import { canEnterLot } from '@school-election/election-core'
import type { Database } from '../lib/db.ts'
import { changeElection, requireElectionAccess } from '../lib/election-access.ts'
import { recordLot } from '../lib/lots.ts'
import { ErrorResponse } from '../lib/schemas/common.ts'
import { LotBody, LotRecorded } from '../lib/schemas/lots.ts'

export function lotRoutes(app: FastifyInstance, { db }: { db: Database }, done: (err?: Error) => void): void {
  app.post<{ Body: Static<typeof LotBody> }>('/api/elections/:id/lots', {
    onRequest: requireElectionAccess(db, 'run-rounds', canEnterLot),
    schema: { body: LotBody, response: { '200': LotRecorded, '4xx': ErrorResponse } },
  }, async (request) => changeElection(db, request, (client, access) => recordLot(client, access, request.body)))
  done()
}
