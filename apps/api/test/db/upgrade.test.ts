// Every migration is applied against a database that already holds data:
// migrations run one at a time, and after each one that has a fixture
// (test/fixtures/upgrade/NNNN.sql) the fixture is loaded, so every later
// migration meets populated tables, as it would on a real server.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAuditChain } from '../../lib/audit.ts'
import { verifyAuditChain } from '../../lib/audit-chain.ts'
import { byName, migrate, MIGRATIONS_DIR } from '../../scripts/migrate.ts'
import { createTestDatabase, DB, TEST_RUNTIME_PASSWORD, withClient } from '../helpers/db.ts'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/upgrade')

test('every migration applies on top of its predecessors and their fixtures', DB, async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort(byName)
  for (const file of files) {
    assert.deepEqual(await migrate({ databaseUrl: db.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD, until: file }), [file])
    const fixture = path.join(FIXTURES, file.slice(0, 4) + '.sql')
    if (existsSync(fixture)) {
      const sql = await readFile(fixture, 'utf8')
      await withClient(db.ownerUrl, (client) => client.query(sql))
    }
  }
  assert.ok(files.length > 0)
  // The audit log the fixtures recorded still verifies after every migration.
  await withClient(db.ownerUrl, async (client) => {
    const { rows } = await client.query<{ election_id: string }>('select distinct election_id from audit_event order by election_id')
    assert.ok(rows.length > 0)
    for (const { election_id: electionId } of rows) {
      assert.equal(verifyAuditChain(await readAuditChain(client, electionId)).valid, true, electionId)
    }
  })
})

test('an audit event without its election stops the migration that ties events to elections, and nothing of it applies', DB, async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  await migrate({ databaseUrl: db.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD, until: '0004_elections.sql' })
  // The 0003 events without the 0004 fixture, which gives them their election.
  const sql = await readFile(path.join(FIXTURES, '0003.sql'), 'utf8')
  await withClient(db.ownerUrl, (client) => client.query(sql))
  await assert.rejects(
    migrate({ databaseUrl: db.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD, until: '0005_audit_event_election.sql' }),
    /0005_audit_event_election\.sql failed with SQLSTATE 23503; nothing of it was applied/,
  )
  const applied = await withClient(db.ownerUrl, (client) => client.query<{ filename: string }>('select filename from schema_migrations order by filename'))
  assert.equal(applied.rows.at(-1)?.filename, '0004_elections.sql')
})
