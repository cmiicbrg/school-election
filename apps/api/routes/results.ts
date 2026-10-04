// The election's result as it stands (lib/outcome.ts): per contest the
// first-round snapshot, the runoff's once it has closed, the recorded lots
// and the outcome resolved from them now; once the election is final, the
// outcome as declared at finalization, and when, by whom and why. For
// every member, including witnesses, once the regular round has closed;
// 409 before, for every role.
//
//   GET /api/elections/:id/result

import type { FastifyInstance } from 'fastify'
import { canShowResults } from '@school-election/election-core'
import { readSnapshot, type Database } from '../lib/db.ts'
import { electionAccessOf, requireElectionAccess } from '../lib/election-access.ts'
import { contestOutcomes, finalizationOf } from '../lib/outcome.ts'
import { ErrorResponse } from '../lib/schemas/common.ts'
import { ElectionResult } from '../lib/schemas/lots.ts'

export function resultRoutes(app: FastifyInstance, { db }: { db: Database }, done: (err?: Error) => void): void {
  app.get('/api/elections/:id/result', {
    onRequest: requireElectionAccess(db, 'view-results', (lifecycle) => canShowResults(lifecycle, 'regular')),
    schema: { response: { '200': ElectionResult, '4xx': ErrorResponse } },
  }, async (request) => readSnapshot(db, async (client) => {
    const { electionId } = electionAccessOf(request)
    const contests = await contestOutcomes(client, electionId)
    return {
      contests: contests.map(({ contestId, first, runoff, lots, outcome }) => ({ contestId, first, runoff, lots, outcome })),
      finalized: await finalizationOf(client, electionId),
    }
  }))
  done()
}
