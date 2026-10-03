// Elections and their audit log. Every route under /api/elections/:id
// passes requireElectionAccess first (lib/election-access.ts).
//
//   POST  /api/elections            a teacher creates a draft, from a preset or empty, and becomes its owner
//   GET   /api/elections            the elections the caller is a bound member of
//   GET   /api/elections/:id        one election, with the caller's role and permissions
//   PATCH /api/elections/:id        its title or description, until voting starts
//   GET   /api/elections/:id/audit  its audit log, and whether the chain verifies

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from 'typebox'
import { canEditCandidates, ELECTION_STATES, NEW_ELECTION, ROUND_STATES, type ElectionState, type Lifecycle } from '@school-election/election-core'
import { boundedName } from '../lib/app-user.ts'
import { appendAudit, readAuditChain } from '../lib/audit.ts'
import { verifyAuditChain } from '../lib/audit-chain.ts'
import { callerOf, requireGlobalRole, requireSession } from '../lib/auth.ts'
import { cleaned, createContest, MAX_TITLE } from '../lib/configuration.ts'
import type { Database } from '../lib/db.ts'
import { changeElection, electionAccessOf, requireElectionAccess } from '../lib/election-access.ts'
import { inOrder } from '../lib/in-order.ts'
import { ELECTION_ACTIONS, ELECTION_ROLES, permissionsOf, type ElectionRole } from '../lib/permissions.ts'
import { PRESET_IDS, PRESETS } from '../lib/presets.ts'
import { ErrorResponse, Literals, MultiLineText, SingleLineText, StrictObject } from '../lib/schemas/common.ts'
import { ElectionUpdateBody } from '../lib/schemas/configuration.ts'

const CreateElectionBody = StrictObject({
  title: SingleLineText(200),
  description: Type.Optional(MultiLineText(2000)),
  /** The contests the election starts with (lib/presets.ts); without one it starts empty. */
  preset: Type.Optional(Literals(PRESET_IDS)),
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
  /** What the caller's role allows; the lifecycle decides what is possible now. */
  permissions: Type.Array(Literals(ELECTION_ACTIONS)),
  /** The election's state with its rounds', as the lifecycle in election-core reads them. */
  lifecycle: StrictObject({
    election: Literals(ELECTION_STATES),
    regular: Literals(ROUND_STATES),
    runoff: Type.Union([Literals(['open', 'closed'] as const), Type.Null()]),
  }),
})

const AuditLogResponse = StrictObject({
  events: Type.Array(StrictObject({
    seq: Type.Integer(),
    electionId: Type.String(),
    at: Type.String(),
    actor: StrictObject({ tid: Type.String(), oid: Type.String(), name: Type.String() }),
    action: Type.String(),
    metadata: Type.Record(Type.String(), Type.Union([Type.String(), Type.Integer()])),
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

// The state is the lifecycle's, not the row's: the row is read after the
// guard, and a transition in between would otherwise make the two disagree.
function detail(row: ElectionRow, role: ElectionRole, lifecycle: Lifecycle): Static<typeof ElectionDetail> {
  return { id: row.id, title: row.title, description: row.description, state: lifecycle.election, role, permissions: permissionsOf(role), lifecycle }
}

export function electionRoutes(app: FastifyInstance, { db }: { db: Database }, done: (err?: Error) => void): void {
  app.post<{ Body: Static<typeof CreateElectionBody> }>('/api/elections', {
    onRequest: requireGlobalRole('teacher'),
    schema: { body: CreateElectionBody, response: { '201': ElectionDetail, '4xx': ErrorResponse } },
  }, async (request, reply) => {
    const caller = callerOf(request)
    const { description = '', preset } = request.body
    const title = cleaned(request.body.title, MAX_TITLE)
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
      const actor = { tid: owner.tid, oid: owner.oid, name: boundedName(owner.display_name) ?? owner.oid }
      await appendAudit(client, election.id, { actor, action: 'election.created', metadata: { title } })
      // A preset's contests, each recorded like one the owner adds.
      const access = { electionId: election.id, role: 'owner' as const, lifecycle: NEW_ELECTION, actor }
      await inOrder(preset === undefined ? [] : PRESETS[preset], (contest) => createContest(client, access, contest))
      return election
    })
    return reply.code(201).send(detail(row, 'owner', NEW_ELECTION))
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
    return detail(row, access.role, access.lifecycle)
  })

  app.patch<{ Body: Static<typeof ElectionUpdateBody> }>('/api/elections/:id', {
    onRequest: requireElectionAccess(db, 'configure', canEditCandidates),
    schema: { body: ElectionUpdateBody, response: { '200': ElectionDetail, '4xx': ErrorResponse } },
  }, async (request) => {
    const row = await changeElection(db, request, async (client, access) => {
      const { rows: [current] } = await client.query<ElectionRow>('select id, title, description, state from election where id = $1', [access.electionId])
      if (!current) throw new Error('an election the guard found is gone')
      const title = request.body.title === undefined ? current.title : cleaned(request.body.title, MAX_TITLE)
      const { description = current.description } = request.body
      if (title === current.title && description === current.description) return current
      await client.query('update election set title = $2, description = $3 where id = $1', [access.electionId, title, description])
      await appendAudit(client, access.electionId, { actor: access.actor, action: 'election.updated', metadata: { title, description } })
      return { ...current, title, description }
    })
    const access = electionAccessOf(request)
    return detail(row, access.role, access.lifecycle)
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
