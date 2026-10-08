// The baseline applies on an empty database, the fixture of a finalized
// election (test/fixtures/upgrade/0001.sql) loads on it, and every later
// migration applies on top of both, as it would on a server with data:
// after each one that has a fixture (test/fixtures/upgrade/NNNN.sql) the
// fixture is loaded, so every migration after it meets populated tables.

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

test('the baseline applies, the fixture loads, and every later migration applies on top of them', DB, async (t) => {
  const db = await createTestDatabase(t, { migrated: false })
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort(byName)
  assert.equal(files[0], '0001_baseline.sql')
  for (const file of files) {
    assert.deepEqual(await migrate({ databaseUrl: db.ownerUrl, runtimePassword: TEST_RUNTIME_PASSWORD, until: file }), [file])
    const fixture = path.join(FIXTURES, file.slice(0, 4) + '.sql')
    if (existsSync(fixture)) {
      const sql = await readFile(fixture, 'utf8')
      await withClient(db.ownerUrl, (client) => client.query(sql))
    }
  }
  await withClient(db.ownerUrl, async (client) => {
    // The finalized election is final with its declared outcome, and the
    // audit log the fixture recorded still verifies after every migration.
    const { rows: finals } = await client.query<{ title: string, outcomes: number }>(
      `select e.title, (select count(*)::int from final_outcome f where f.election_id = e.id) as outcomes
         from election e join election_state s on s.state = e.state where s.final order by e.title`,
    )
    assert.deepEqual(finals, [{ title: 'Klassensprecherwahl 3B', outcomes: 1 }])
    // Every election has its one owner, a person, whoever wrote the row.
    const { rows: owners } = await client.query<{ owners: number, people: number }>(
      `select count(m.id)::int as owners, count(m.user_id)::int as people
         from election e left join election_member m on m.election_id = e.id and m.role = 'owner' group by e.id`,
    )
    assert.ok(owners.length > 0 && owners.every((row) => row.owners === 1 && row.people === 1), JSON.stringify(owners))
    const { rows } = await client.query<{ election_id: string }>('select distinct election_id from audit_event order by election_id')
    assert.ok(rows.length > 0)
    for (const { election_id: electionId } of rows) {
      assert.equal(verifyAuditChain(await readAuditChain(client, electionId)).valid, true, electionId)
    }
  })
})
