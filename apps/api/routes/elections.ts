// Elections and their audit log. Every route under /api/elections/:id
// passes requireElectionAccess first (lib/election-access.ts).
//
//   POST /api/elections            a teacher creates a draft and becomes its owner
//   GET  /api/elections            the elections the caller is a bound member of
//   GET  /api/elections/:id        one election, with the caller's role and permissions
//   GET  /api/elections/:id/audit  its audit log, and whether the chain verifies

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from 'typebox'
import { ELECTION_STATES, type ElectionState } from '@school-election/election-core'
import { boundedName } from '../lib/app-user.ts'
import { appendAudit, readAuditChain } from '../lib/audit.ts'
import { verifyAuditChain } from '../lib/audit-chain.ts'
import { callerOf, requireGlobalRole, requireSession } from '../lib/auth.ts'
import type { Database } from '../lib/db.ts'
import { electionAccessOf, requireElectionAccess } from '../lib/election-access.ts'
import { ELECTION_ACTIONS, ELECTION_ROLES, permissionsOf, type ElectionRole } from '../lib/permissions.ts'
import { ErrorResponse, Literals, MultiLineText, SingleLineText, StrictObject } from '../lib/schemas/common.ts'

const CreateElectionBody = StrictObject({
  title: SingleLineText(200),
  description: Type.Optional(MultiLineText(2000)),
})

const ElectionSummary = StrictObject({
  id: Type.String(),
  title: Type.String(),
  state: Literals(ELECTION_STATES),
  role: Literals(ELECTION_ROLES),
})

const ElectionDetail = StrictObject({
  id: Type.String(),
  title: Type.String(),
  description: Type.String(),
  state: Literals(ELECTION_STATES),
  role: Literals(ELECTION_ROLES),
  /** What the caller's role allows; the state decides what is possible now. */
  permissions: Type.Array(Literals(ELECTION_ACTIONS)),
})

const AuditLogResponse = StrictObject({
  events: Type.Array(StrictObject({
    seq: Type.Integer(),
    electionId: Type.String(),
    at: Type.String(),
    actor: StrictObject({ tid: Type.String(), oid: Type.String(), name: Type.String() }),
    action: Type.String(),
    metadata: Type.Record(Type.String(), Type.String()),
    prevHash: Type.Union([Type.String(), Type.Null()]),
    hash: Type.String(),
  })),
  chain: Type.Union([
    StrictObject({ valid: Type.Literal(true), length: Type.Integer(), head: Type.Union([Type.String(), Type.Null()]) }),
    StrictObject({ valid: Type.Literal(false), length: Type.Integer(), index: Type.Integer(), problem: Type.String() }),
  ]),
})

interface ElectionRow {
  id: string
  title: string
  description: string
  state: ElectionState
}

function detail(row: ElectionRow, role: ElectionRole): Static<typeof ElectionDetail> {
  return { id: row.id, title: row.title, description: row.description, state: row.state, role, permissions: permissionsOf(role) }
}

export function electionRoutes(app: FastifyInstance, { db }: { db: Database }, done: (err?: Error) => void): void {
  app.post<{ Body: Static<typeof CreateElectionBody> }>('/api/elections', {
    onRequest: requireGlobalRole('teacher'),
    schema: { body: CreateElectionBody, response: { '201': ElectionDetail, '4xx': ErrorResponse } },
  }, async (request, reply) => {
    const caller = callerOf(request)
    const { title, description = '' } = request.body
    const row = await db.tx(async (client) => {
      const { rows: [election] } = await client.query<ElectionRow>(
        'insert into election (title, description) values ($1, $2) returning id, title, description, state',
        [title, description],
      )
      if (!election) throw new Error('election insert returned no row')
      // The creator becomes the owner; the audit log names them by their
      // Entra identity.
      const { rows: [owner] } = await client.query<{ tid: string, oid: string, display_name: string }>(
        'select tid, oid, display_name from app_user where id = $1',
        [caller.id],
      )
      if (!owner) throw new Error('the signed-in caller has no app_user row')
      await client.query('insert into election_member (election_id, role, user_id) values ($1, \'owner\', $2)', [election.id, caller.id])
      await appendAudit(client, election.id, {
        actor: { tid: owner.tid, oid: owner.oid, name: boundedName(owner.display_name) ?? owner.oid },
        action: 'election.created',
        metadata: { title },
      })
      return election
    })
    return reply.code(201).send(detail(row, 'owner'))
  })

  app.get('/api/elections', {
    onRequest: requireSession,
    schema: { response: { '200': Type.Array(ElectionSummary), '4xx': ErrorResponse } },
  }, async (request) => {
    const { rows } = await db.query<Static<typeof ElectionSummary>>(
      `select e.id, e.title, e.state, m.role
         from election_member m join election e on e.id = m.election_id
        where m.user_id = $1
        order by e.title, e.id`,
      [callerOf(request).id],
    )
    return rows
  })

  app.get('/api/elections/:id', {
    onRequest: requireElectionAccess(db, 'view'),
    schema: { response: { '200': ElectionDetail, '4xx': ErrorResponse } },
  }, async (request) => {
    const access = electionAccessOf(request)
    const { rows: [row] } = await db.query<ElectionRow>('select id, title, description, state from election where id = $1', [access.electionId])
    if (!row) throw new Error('an election the guard found is gone')
    return detail(row, access.role)
  })

  app.get('/api/elections/:id/audit', {
    onRequest: requireElectionAccess(db, 'view'),
    schema: { response: { '200': AuditLogResponse, '4xx': ErrorResponse } },
  }, async (request) => {
    const events = await db.tx((client) => readAuditChain(client, electionAccessOf(request).electionId))
    return { events, chain: verifyAuditChain(events) }
  })
  done()
}
