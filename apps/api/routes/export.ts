// The election's export (lib/export.ts): a file for the committee, from
// which anyone recomputes the results and checks the audit chain offline
// (npm run verify). For every member once the regular round has closed
// and no round is open; a POST, since the export is audited with the
// file's digest.
//
//   POST /api/elections/:id/export   the file, as canonical JSON, with its SHA-256 in x-export-sha256

import type { FastifyInstance } from 'fastify'
import { canExport } from '@school-election/election-core'
import type { Config } from '../config.ts'
import { appendAudit } from '../lib/audit.ts'
import type { Database } from '../lib/db.ts'
import { changeElection, requireElectionAccess } from '../lib/election-access.ts'
import { buildExport } from '../lib/export.ts'
import { ErrorResponse } from '../lib/schemas/common.ts'

export function exportRoutes(app: FastifyInstance, { db, config }: { db: Database, config: Config }, done: (err?: Error) => void): void {
  app.post('/api/elections/:id/export', {
    onRequest: requireElectionAccess(db, 'view-results', canExport),
    schema: { response: { '4xx': ErrorResponse } },
  }, async (request, reply) => {
    const built = await changeElection(db, request, async (client, access) => {
      const result = await buildExport(client, access.electionId, config.build)
      await appendAudit(client, access.electionId, { actor: access.actor, action: 'export.generated', metadata: { sha256: result.sha256, bytes: result.bytes } })
      return result
    })
    return reply
      .type('application/json')
      .header('x-export-sha256', built.sha256)
      .header('content-disposition', `attachment; filename="wahl-${built.document.election.id}.json"`)
      .send(built.text)
  })
  done()
}
