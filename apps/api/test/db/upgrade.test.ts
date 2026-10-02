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
})
