// Co-admins and witnesses of an election. They are invited by their school
// e-mail address; the invitation is bound to the person when they next
// sign in with it (lib/members.ts), and grants nothing until then.
//
//   GET    /api/elections/:id/members             every member, pending or bound (any member)
//   POST   /api/elections/:id/members             invite a co-admin or witness (owner)
//   DELETE /api/elections/:id/members/:memberId   remove an invitation or a member (owner)

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from 'typebox'
import { canManageMembers } from '@school-election/election-core'
import type { Database } from '../lib/db.ts'
import { changeElection, electionAccessOf, requireElectionAccess } from '../lib/election-access.ts'
import { inviteMember, listMembers, removeMember } from '../lib/members.ts'
import { ELECTION_ROLES, INVITED_ROLES } from '../lib/permissions.ts'
import { EmailAddress, ErrorResponse, Literals, StrictObject, Uuid } from '../lib/schemas/common.ts'

const Member = StrictObject({
  id: Type.String(),
  role: Literals(ELECTION_ROLES),
  status: Literals(['pending', 'bound'] as const),
  email: Type.Union([Type.String(), Type.Null()]),
  displayName: Type.Union([Type.String(), Type.Null()]),
})

const InviteBody = StrictObject({
  email: EmailAddress,
  role: Literals(INVITED_ROLES),
})

const MemberParams = Type.Object({
  id: Type.String(),
  memberId: Uuid,
})

export async function memberRoutes(app: FastifyInstance, { db }: { db: Database }): Promise<void> {
  app.get('/api/elections/:id/members', {
    onRequest: requireElectionAccess(db, 'view'),
    schema: { response: { '200': Type.Array(Member), '4xx': ErrorResponse } },
  }, async (request) => listMembers(db, electionAccessOf(request).electionId))

  app.post<{ Body: Static<typeof InviteBody> }>('/api/elections/:id/members', {
    onRequest: requireElectionAccess(db, 'manage-members', canManageMembers),
    schema: { body: InviteBody, response: { '201': Member, '4xx': ErrorResponse } },
  }, async (request, reply) => {
    const { email, role } = request.body
    const member = await changeElection(db, request, (client, access) => inviteMember(client, access, email, role))
    return reply.code(201).send(member)
  })

  app.delete<{ Params: Static<typeof MemberParams> }>('/api/elections/:id/members/:memberId', {
    onRequest: requireElectionAccess(db, 'manage-members', canManageMembers),
    schema: { params: MemberParams, response: { '4xx': ErrorResponse } },
  }, async (request, reply) => {
    await changeElection(db, request, (client, access) => removeMember(client, access, request.params.memberId))
    return reply.code(204).send()
  })
}
