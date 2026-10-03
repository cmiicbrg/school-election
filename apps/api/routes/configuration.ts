// The configuration of an election, one kind of thing per route. Every
// route passes requireElectionAccess first; a change needs the configure
// permission and its editing window, and runs in changeElection with its
// audit event (lib/configuration.ts).
//
//   GET    /api/elections/:id/configuration                    contests, candidates, voter groups (any member)
//   POST   /api/elections/:id/contests                         a contest (draft)
//   PATCH  /api/elections/:id/contests/:contestId              its title or ruleset (draft)
//   DELETE /api/elections/:id/contests/:contestId              with its candidates and mapping (draft)
//   POST   /api/elections/:id/contests/:contestId/candidates   a candidate (until voting starts)
//   PATCH  /api/elections/:id/candidates/:candidateId          correct a name (until voting starts)
//   DELETE /api/elections/:id/candidates/:candidateId          (until voting starts)
//   POST   /api/elections/:id/voter-groups                     a voter group (draft)
//   PATCH  /api/elections/:id/voter-groups/:groupId            rename it (draft)
//   DELETE /api/elections/:id/voter-groups/:groupId            (draft)
//   PUT    /api/elections/:id/voter-groups/:groupId/contests   the contests it votes in (draft)
//
// Candidate routes answer with the contest, its candidates in ballot order,
// so no client has to sort them.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from 'typebox'
import { canEditCandidates, canEditStructure } from '@school-election/election-core'
import {
  addCandidate,
  createContest,
  createVoterGroup,
  readConfiguration,
  removeCandidate,
  removeContest,
  removeVoterGroup,
  renameCandidate,
  renameVoterGroup,
  setVoterGroupContests,
  updateContest,
} from '../lib/configuration.ts'
import { readSnapshot, type Database } from '../lib/db.ts'
import { changeElection, electionAccessOf, requireElectionAccess } from '../lib/election-access.ts'
import { ErrorResponse, Uuid } from '../lib/schemas/common.ts'
import {
  CandidateBody,
  CandidateUpdateBody,
  Configuration,
  Contest,
  ContestBody,
  ContestUpdateBody,
  VoterGroup,
  VoterGroupBody,
  VoterGroupContestsBody,
} from '../lib/schemas/configuration.ts'

const ContestParams = Type.Object({ id: Type.String(), contestId: Uuid })
const CandidateParams = Type.Object({ id: Type.String(), candidateId: Uuid })
const GroupParams = Type.Object({ id: Type.String(), groupId: Uuid })

export function configurationRoutes(app: FastifyInstance, { db }: { db: Database }, done: (err?: Error) => void): void {
  const structure = () => requireElectionAccess(db, 'configure', canEditStructure)
  const candidates = () => requireElectionAccess(db, 'configure', canEditCandidates)
  const answers = (schema: object, status = '200') => ({ [status]: schema, '4xx': ErrorResponse })

  app.get('/api/elections/:id/configuration', {
    onRequest: requireElectionAccess(db, 'view'),
    schema: { response: answers(Configuration) },
  }, async (request) => readSnapshot(db, (client) => readConfiguration(client, electionAccessOf(request).electionId)))

  // --- contests ---

  app.post<{ Body: Static<typeof ContestBody> }>('/api/elections/:id/contests', {
    onRequest: structure(),
    schema: { body: ContestBody, response: answers(Contest, '201') },
  }, async (request, reply) => {
    const contest = await changeElection(db, request, (client, access) => createContest(client, access, request.body))
    return reply.code(201).send(contest)
  })

  app.patch<{ Params: Static<typeof ContestParams>, Body: Static<typeof ContestUpdateBody> }>('/api/elections/:id/contests/:contestId', {
    onRequest: structure(),
    schema: { params: ContestParams, body: ContestUpdateBody, response: answers(Contest) },
  }, async (request) => changeElection(db, request, (client, access) => updateContest(client, access, request.params.contestId, request.body)))

  app.delete<{ Params: Static<typeof ContestParams> }>('/api/elections/:id/contests/:contestId', {
    onRequest: structure(),
    schema: { params: ContestParams, response: { '4xx': ErrorResponse } },
  }, async (request, reply) => {
    await changeElection(db, request, (client, access) => removeContest(client, access, request.params.contestId))
    return reply.code(204).send()
  })

  // --- candidates ---

  app.post<{ Params: Static<typeof ContestParams>, Body: Static<typeof CandidateBody> }>('/api/elections/:id/contests/:contestId/candidates', {
    onRequest: candidates(),
    schema: { params: ContestParams, body: CandidateBody, response: answers(Contest, '201') },
  }, async (request, reply) => {
    const contest = await changeElection(db, request, (client, access) => addCandidate(client, access, request.params.contestId, request.body))
    return reply.code(201).send(contest)
  })

  app.patch<{ Params: Static<typeof CandidateParams>, Body: Static<typeof CandidateUpdateBody> }>('/api/elections/:id/candidates/:candidateId', {
    onRequest: candidates(),
    schema: { params: CandidateParams, body: CandidateUpdateBody, response: answers(Contest) },
  }, async (request) => changeElection(db, request, (client, access) => renameCandidate(client, access, request.params.candidateId, request.body)))

  app.delete<{ Params: Static<typeof CandidateParams> }>('/api/elections/:id/candidates/:candidateId', {
    onRequest: candidates(),
    schema: { params: CandidateParams, response: answers(Contest) },
  }, async (request) => changeElection(db, request, (client, access) => removeCandidate(client, access, request.params.candidateId)))

  // --- voter groups ---

  app.post<{ Body: Static<typeof VoterGroupBody> }>('/api/elections/:id/voter-groups', {
    onRequest: structure(),
    schema: { body: VoterGroupBody, response: answers(VoterGroup, '201') },
  }, async (request, reply) => {
    const group = await changeElection(db, request, (client, access) => createVoterGroup(client, access, request.body))
    return reply.code(201).send(group)
  })

  app.patch<{ Params: Static<typeof GroupParams>, Body: Static<typeof VoterGroupBody> }>('/api/elections/:id/voter-groups/:groupId', {
    onRequest: structure(),
    schema: { params: GroupParams, body: VoterGroupBody, response: answers(VoterGroup) },
  }, async (request) => changeElection(db, request, (client, access) => renameVoterGroup(client, access, request.params.groupId, request.body)))

  app.delete<{ Params: Static<typeof GroupParams> }>('/api/elections/:id/voter-groups/:groupId', {
    onRequest: structure(),
    schema: { params: GroupParams, response: { '4xx': ErrorResponse } },
  }, async (request, reply) => {
    await changeElection(db, request, (client, access) => removeVoterGroup(client, access, request.params.groupId))
    return reply.code(204).send()
  })

  app.put<{ Params: Static<typeof GroupParams>, Body: Static<typeof VoterGroupContestsBody> }>('/api/elections/:id/voter-groups/:groupId/contests', {
    onRequest: structure(),
    schema: { params: GroupParams, body: VoterGroupContestsBody, response: answers(VoterGroup) },
  }, async (request) => changeElection(db, request, (client, access) => setVoterGroupContests(client, access, request.params.groupId, request.body.contestIds)))
  done()
}
