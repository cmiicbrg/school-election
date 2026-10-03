// Batches of voting keys (lib/credentials.ts). Every route passes
// requireElectionAccess first.
//
//   GET  /api/elections/:id/batches                    every batch, counts only (any member)
//   GET  /api/elections/:id/batches/:batchId           a batch with its keys: owner and co-admins any
//                                                      time, a witness once the batch's round has closed
//   POST /api/elections/:id/batches                    issue a batch for a voter group, the first or a
//                                                      top-up, and get its keys (issue-keys)
//   POST /api/elections/:id/batches/:batchId/replace   void a batch and issue as many new keys (issue-keys)
//
// Keys travel in response bodies only, never in a path or a query, and
// every answer is no-store like the rest of the API. The lifecycle guard
// of the two changes is the widest window, a runoff batch's, because the
// round kind arrives in the body, which is read after the guard; the
// library refuses per kind (409 voting_started). The print page in the
// web app reads a batch through the second route, as often as it likes:
// reading creates no keys.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from 'typebox'
import { canIssueBatch } from '@school-election/election-core'
import { issueBatch, listBatches, readBatchKeys, replaceBatch } from '../lib/credentials.ts'
import { readSnapshot, type Database } from '../lib/db.ts'
import { changeElection, electionAccessOf, requireElectionAccess } from '../lib/election-access.ts'
import { BatchKeys, BatchList, IssueBatchBody } from '../lib/schemas/batches.ts'
import { ErrorResponse, Uuid } from '../lib/schemas/common.ts'

const BatchParams = Type.Object({ id: Type.String(), batchId: Uuid })

export function batchRoutes(app: FastifyInstance, { db }: { db: Database }, done: (err?: Error) => void): void {
  const issuing = () => requireElectionAccess(db, 'issue-keys', (lifecycle) => canIssueBatch(lifecycle, 'runoff'))

  app.get('/api/elections/:id/batches', {
    onRequest: requireElectionAccess(db, 'view'),
    schema: { response: { '200': BatchList, '4xx': ErrorResponse } },
  }, async (request) => ({ batches: await listBatches(db, electionAccessOf(request).electionId) }))

  app.get<{ Params: Static<typeof BatchParams> }>('/api/elections/:id/batches/:batchId', {
    onRequest: requireElectionAccess(db, 'view'),
    schema: { params: BatchParams, response: { '200': BatchKeys, '4xx': ErrorResponse } },
  }, async (request) => readSnapshot(db, (client) => readBatchKeys(client, electionAccessOf(request), request.params.batchId)))

  app.post<{ Body: Static<typeof IssueBatchBody> }>('/api/elections/:id/batches', {
    onRequest: issuing(),
    schema: { body: IssueBatchBody, response: { '201': BatchKeys, '4xx': ErrorResponse } },
  }, async (request, reply) => {
    const issued = await changeElection(db, request, (client, access) => issueBatch(client, access, request.body))
    return reply.code(201).send(issued)
  })

  app.post<{ Params: Static<typeof BatchParams> }>('/api/elections/:id/batches/:batchId/replace', {
    onRequest: issuing(),
    schema: { params: BatchParams, response: { '201': BatchKeys, '4xx': ErrorResponse } },
  }, async (request, reply) => {
    const replacement = await changeElection(db, request, (client, access) => replaceBatch(client, access, request.params.batchId))
    return reply.code(201).send(replacement)
  })
  done()
}
