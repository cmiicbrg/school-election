// Candidate pictures (lib/pictures.ts).
//
//   PUT    /api/elections/:id/candidates/:candidateId/picture           upload, as base64 in JSON (until voting starts)
//   DELETE /api/elections/:id/candidates/:candidateId/picture           (until voting starts)
//   GET    /api/elections/:id/candidates/:candidateId/picture/:sha256   the picture, image/webp (any member)
//
// The upload route alone takes a larger body than the API's 64 KiB. JSON
// rather than multipart: one body format for every route, which the CSRF
// rules rely on (a cross-site form can send multipart without a
// preflight), and the browser's prepared picture is small.
//
// A picture is served under its content hash, so its URL changes whenever
// the picture does, and an old URL names a picture that is gone (404). That
// is what makes the one exception to the API's no-store rule safe: a 200 or
// 304 of this route may be kept by the browser for good. Access is checked
// on every request, the revalidation with If-None-Match included.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from 'typebox'
import { canEditCandidates } from '@school-election/election-core'
import { removeCandidatePicture, setCandidatePicture } from '../lib/configuration.ts'
import type { Database } from '../lib/db.ts'
import { changeElection, electionAccessOf, Refusal, requireElectionAccess } from '../lib/election-access.ts'
import { matchesEtag, normalizePicture, PICTURE_BODY_LIMIT, pictureEtag } from '../lib/pictures.ts'
import { ErrorResponse, Uuid } from '../lib/schemas/common.ts'
import { Contest, PictureBody } from '../lib/schemas/configuration.ts'

const PictureParams = Type.Object({ id: Type.String(), candidateId: Uuid })
const ServedParams = Type.Object({ id: Type.String(), candidateId: Uuid, sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }) })

/** Content-addressed: the URL changes with the content, so the browser may keep it for good, for its user only. */
const IMMUTABLE = 'private, max-age=31536000, immutable'

export function pictureRoutes(app: FastifyInstance, { db }: { db: Database }, done: (err?: Error) => void): void {
  app.put<{ Params: Static<typeof PictureParams>, Body: Static<typeof PictureBody> }>('/api/elections/:id/candidates/:candidateId/picture', {
    onRequest: requireElectionAccess(db, 'configure', canEditCandidates),
    bodyLimit: PICTURE_BODY_LIMIT,
    schema: { params: PictureParams, body: PictureBody, response: { '200': Contest, '4xx': ErrorResponse } },
  }, async (request) => {
    // Decoded and re-encoded before the transaction: the election's lock is
    // not held while libvips works.
    const result = await normalizePicture(Buffer.from(request.body.data, 'base64'))
    if (!result.ok) throw new Refusal(result.refusal === 'picture_too_large' ? 413 : 422, result.refusal)
    return changeElection(db, request, (client, access) => setCandidatePicture(client, access, request.params.candidateId, result.picture))
  })

  app.delete<{ Params: Static<typeof PictureParams> }>('/api/elections/:id/candidates/:candidateId/picture', {
    onRequest: requireElectionAccess(db, 'configure', canEditCandidates),
    schema: { params: PictureParams, response: { '200': Contest, '4xx': ErrorResponse } },
  }, async (request) => changeElection(db, request, (client, access) => removeCandidatePicture(client, access, request.params.candidateId)))

  app.get<{ Params: Static<typeof ServedParams> }>('/api/elections/:id/candidates/:candidateId/picture/:sha256', {
    onRequest: requireElectionAccess(db, 'view'),
    // The hardening plugin keeps this route's Cache-Control on a 200 or 304.
    config: { contentAddressed: true },
    schema: { params: ServedParams, response: { '4xx': ErrorResponse } },
  }, async (request, reply) => {
    const { candidateId, sha256 } = request.params
    const revalidating = matchesEtag(request.headers['if-none-match'], sha256)
    // A revalidation needs to know that the picture is still there, not its bytes.
    const { rows: [row] } = await db.query<{ picture: Buffer | null }>(
      revalidating
        ? 'select null as picture from candidate where id = $1 and election_id = $2 and picture_sha256 = $3'
        : 'select picture from candidate where id = $1 and election_id = $2 and picture_sha256 = $3',
      [candidateId, electionAccessOf(request).electionId, sha256],
    )
    if (!row) throw new Refusal(404, 'not_found')
    void reply.header('etag', pictureEtag(sha256)).header('cache-control', IMMUTABLE)
    if (revalidating) return reply.code(304).send()
    return reply.type('image/webp').send(row.picture)
  })
  done()
}
