// Preparing an election and taking it back to draft (lib/prepare.ts).
//
//   GET  /api/elections/:id/preparation   the summary, its warnings and what blocks preparing (any member)
//   POST /api/elections/:id/prepare       draft → prepared: 200 with the summary and warnings,
//                                         or 409 not_ready with the problems
//   POST /api/elections/:id/unprepare     prepared → draft, before any round has opened

import type { FastifyInstance } from 'fastify'
import { readSnapshot, type Database } from '../lib/db.ts'
import { canTransition, changeElection, electionAccessOf, requireElectionAccess } from '../lib/election-access.ts'
import { prepareElection, readPreparation, unprepareElection } from '../lib/prepare.ts'
import { ErrorResponse } from '../lib/schemas/common.ts'
import { Prepared, PrepareRefusal, Preparation, StateResponse } from '../lib/schemas/configuration.ts'

export function prepareRoutes(app: FastifyInstance, { db }: { db: Database }, done: (err?: Error) => void): void {
  app.get('/api/elections/:id/preparation', {
    onRequest: requireElectionAccess(db, 'view'),
    schema: { response: { '200': Preparation, '4xx': ErrorResponse } },
  }, async (request) => readSnapshot(db, (client) => readPreparation(client, electionAccessOf(request).electionId)))

  app.post('/api/elections/:id/prepare', {
    onRequest: requireElectionAccess(db, 'prepare', canTransition('prepare')),
    schema: { response: { '200': Prepared, '4xx': PrepareRefusal } },
  }, async (request, reply) => {
    const result = await changeElection(db, request, (client, access) => prepareElection(client, access))
    if (!result.prepared) return reply.code(409).send({ error: 'not_ready', problems: result.problems })
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
