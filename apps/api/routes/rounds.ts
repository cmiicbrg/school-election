// The regular round: testing it, opening it, watching turnout, closing it
// with the count, and reading the result (lib/rounds.ts, lib/tally.ts).
//
//   POST /api/elections/:id/rounds/regular/test         prepared: the round planned → testing
//   POST /api/elections/:id/rounds/regular/test/end     testing → planned, nothing kept
//   GET  /api/elections/:id/rounds/regular/test-result  the count of the test's ballots, while testing (any member)
//   POST /api/elections/:id/rounds/regular/open         prepared → active, the round planned → open; a test ends first
//   POST /api/elections/:id/rounds/regular/close        the seal and the count, in one transaction
//   GET  /api/elections/:id/rounds/regular/turnout      counts by contest and by key, in every state (any member)
//   GET  /api/elections/:id/rounds/regular/result       the snapshots, once the round has closed; 409 before, for every role

import type { FastifyInstance } from 'fastify'
import { canOpenRegular, canShowResults, canShowTestResult } from '@school-election/election-core'
import type { Config } from '../config.ts'
import { readSnapshot, type Database } from '../lib/db.ts'
import { canTransition, changeElection, electionAccessOf, requireElectionAccess } from '../lib/election-access.ts'
import { closeAndTally, endTest, openRound, readTurnout, startTest } from '../lib/rounds.ts'
import { ErrorResponse } from '../lib/schemas/common.ts'
import { RoundClosed, RoundResults, RoundStates, TestEnded, Turnout } from '../lib/schemas/rounds.ts'
import { readResults, tallyTest } from '../lib/tally.ts'

export function roundRoutes(app: FastifyInstance, { db, config }: { db: Database, config: Config }, done: (err?: Error) => void): void {
  const { build } = config

  app.post('/api/elections/:id/rounds/regular/test', {
    onRequest: requireElectionAccess(db, 'run-rounds', canTransition('start-test')),
    schema: { response: { '200': RoundStates, '4xx': ErrorResponse } },
  }, async (request) => {
    await changeElection(db, request, (client, access) => startTest(client, access))
    return { election: 'prepared' as const, round: 'testing' as const }
  })

  app.post('/api/elections/:id/rounds/regular/test/end', {
    onRequest: requireElectionAccess(db, 'run-rounds', canTransition('end-test')),
    schema: { response: { '200': TestEnded, '4xx': ErrorResponse } },
  }, async (request) => {
    const ended = await changeElection(db, request, (client, access) => endTest(client, access))
    return { election: 'prepared' as const, round: 'planned' as const, ...ended }
  })

  app.get('/api/elections/:id/rounds/regular/test-result', {
    onRequest: requireElectionAccess(db, 'view-results', canShowTestResult),
    schema: { response: { '200': RoundResults, '4xx': ErrorResponse } },
  }, async (request) => readSnapshot(db, async (client) => {
    const { electionId } = electionAccessOf(request)
    const { rows: [round] } = await client.query<{ id: string }>(`select id from round where election_id = $1 and kind = 'regular'`, [electionId])
    return { round: 'testing' as const, contests: round ? await tallyTest(client, electionId, round.id, build) : [] }
  }))

  app.post('/api/elections/:id/rounds/regular/open', {
    onRequest: requireElectionAccess(db, 'run-rounds', canOpenRegular),
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
