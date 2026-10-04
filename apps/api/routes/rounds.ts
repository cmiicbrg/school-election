// The regular round: opening it, watching turnout, closing it with the
// count, and reading the result (lib/rounds.ts, lib/tally.ts).
//
//   POST /api/elections/:id/rounds/regular/open     prepared → active, the round planned → open
//   POST /api/elections/:id/rounds/regular/close    the seal and the count, in one transaction
//   GET  /api/elections/:id/rounds/regular/turnout  counts by contest and by key, in every state (any member)
//   GET  /api/elections/:id/rounds/regular/result   the snapshots, once the round has closed; 409 before, for every role

import type { FastifyInstance } from 'fastify'
import { canShowResults } from '@school-election/election-core'
import type { Config } from '../config.ts'
import { readSnapshot, type Database } from '../lib/db.ts'
import { canTransition, changeElection, electionAccessOf, requireElectionAccess } from '../lib/election-access.ts'
import { closeAndTally, openRound, readTurnout } from '../lib/rounds.ts'
import { ErrorResponse } from '../lib/schemas/common.ts'
import { RoundClosed, RoundResults, RoundStates, Turnout } from '../lib/schemas/rounds.ts'
import { readResults } from '../lib/tally.ts'

export function roundRoutes(app: FastifyInstance, { db, config }: { db: Database, config: Config }, done: (err?: Error) => void): void {
  const { build } = config

  app.post('/api/elections/:id/rounds/regular/open', {
    onRequest: requireElectionAccess(db, 'run-rounds', canTransition('open-regular')),
    schema: { response: { '200': RoundStates, '4xx': ErrorResponse } },
  }, async (request) => {
    await changeElection(db, request, (client, access) => openRound(client, access))
    return { election: 'active' as const, round: 'open' as const }
  })

  app.post('/api/elections/:id/rounds/regular/close', {
    onRequest: requireElectionAccess(db, 'run-rounds', canTransition('close-regular')),
    schema: { response: { '200': RoundClosed, '4xx': ErrorResponse } },
  }, async (request) => {
    const closed = await changeElection(db, request, (client, access) => closeAndTally(client, access, build))
    return { election: 'active' as const, round: 'closed' as const, ...closed }
  })

  app.get('/api/elections/:id/rounds/regular/turnout', {
    onRequest: requireElectionAccess(db, 'view'),
    schema: { response: { '200': Turnout, '4xx': ErrorResponse } },
  }, async (request) => readSnapshot(db, (client) => readTurnout(client, electionAccessOf(request).electionId, 'regular')))

  app.get('/api/elections/:id/rounds/regular/result', {
    onRequest: requireElectionAccess(db, 'view-results', (lifecycle) => canShowResults(lifecycle, 'regular')),
    schema: { response: { '200': RoundResults, '4xx': ErrorResponse } },
  }, async (request) => readSnapshot(db, async (client) => {
    const { electionId } = electionAccessOf(request)
    const { rows: [round] } = await client.query<{ id: string }>(`select id from round where election_id = $1 and kind = 'regular'`, [electionId])
    return { round: 'closed' as const, contests: round ? await readResults(client, electionId, round.id) : [] }
  }))
  done()
}
