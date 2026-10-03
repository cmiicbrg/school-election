// Preparing an election and taking it back to draft (lib/prepare.ts).
//
//   GET  /api/elections/:id/preparation   the summary, its warnings and what blocks preparing (any member)
//   POST /api/elections/:id/prepare       draft → prepared: 200 with the summary and warnings,
//                                         409 not_ready with the problems, or 409 void_required
//                                         with the batches whose keys no longer fit, which
//                                         { confirmVoid: true } voids
//   POST /api/elections/:id/unprepare     prepared → draft, before any round has opened

import type { FastifyInstance } from 'fastify'
import type { Static } from 'typebox'
import { readSnapshot, type Database } from '../lib/db.ts'
import { canTransition, changeElection, electionAccessOf, requireElectionAccess } from '../lib/election-access.ts'
import { prepareElection, readPreparation, unprepareElection } from '../lib/prepare.ts'
import { ErrorResponse } from '../lib/schemas/common.ts'
import { PrepareBody, Prepared, PrepareRefusal, Preparation, StateResponse } from '../lib/schemas/configuration.ts'

export function prepareRoutes(app: FastifyInstance, { db }: { db: Database }, done: (err?: Error) => void): void {
  app.get('/api/elections/:id/preparation', {
    onRequest: requireElectionAccess(db, 'view'),
    schema: { response: { '200': Preparation, '4xx': ErrorResponse } },
  }, async (request) => readSnapshot(db, (client) => readPreparation(client, electionAccessOf(request).electionId)))

  app.post<{ Body: Static<typeof PrepareBody> }>('/api/elections/:id/prepare', {
    onRequest: requireElectionAccess(db, 'prepare', canTransition('prepare')),
    schema: { body: PrepareBody, response: { '200': Prepared, '4xx': PrepareRefusal } },
  }, async (request, reply) => {
    const confirmVoid = request.body?.confirmVoid === true
    const result = await changeElection(db, request, (client, access) => prepareElection(client, access, { confirmVoid }))
    if (!result.prepared) {
      if ('staleBatches' in result) return reply.code(409).send({ error: 'void_required', batches: result.staleBatches })
      return reply.code(409).send({ error: 'not_ready', problems: result.problems })
    }
    return { state: 'prepared' as const, summary: result.summary, warnings: result.warnings }
  })

  app.post('/api/elections/:id/unprepare', {
    onRequest: requireElectionAccess(db, 'prepare', canTransition('unprepare')),
    schema: { response: { '200': StateResponse, '4xx': ErrorResponse } },
  }, async (request) => {
    await changeElection(db, request, (client, access) => unprepareElection(client, access))
    return { state: 'draft' as const }
  })
  done()
}
