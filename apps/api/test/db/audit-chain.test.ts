import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendAudit, AuditError, readAuditChain, type AuditInput } from '../../lib/audit.ts'
import { verifyAuditChain } from '../../lib/audit-chain.ts'
import { createDatabase, type Database } from '../../lib/db.ts'
import { sqlState } from '../../lib/pg-errors.ts'
import { createTestDatabase, DB, withClient } from '../helpers/db.ts'

const ELECTION_A = '3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b'
const ELECTION_B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const ACTOR = { tid: '6F1C2B3A-4D5E-4F60-8A7B-9C0D1E2F3A4B', oid: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', name: 'Maria Huber' }

const invited = (n: number): AuditInput<'member.invited'> =>
  ({ actor: ACTOR, action: 'member.invited', metadata: { upn: `member${n}@school.example`, role: 'witness' } })

/** A migrated database and a pool connected as the runtime role, as the server runs. */
async function setup(t: TestContext): Promise<{ db: Database, ownerUrl: string, runtimeUrl: string }> {
  const testDb = await createTestDatabase(t)
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  return { db, ownerUrl: testDb.ownerUrl, runtimeUrl: testDb.runtimeUrl }
}

const chainOf = (db: Database, electionId: string) => db.tx((client) => readAuditChain(client, electionId))

test('appended events form a chain that verifies, read back exactly as written', DB, async (t) => {
  const { db } = await setup(t)
  const written = [
    await db.tx((client) => appendAudit(client, ELECTION_A, { actor: ACTOR, action: 'election.created', metadata: { title: 'Schulsprecherwahl' } })),
    await db.tx((client) => appendAudit(client, ELECTION_A, invited(1))),
    await db.tx((client) => appendAudit(client, ELECTION_A, invited(2))),
  ]
  const events = await chainOf(db, ELECTION_A)
  assert.deepEqual(events, written)
  assert.deepEqual(verifyAuditChain(events), { valid: true, length: 3, head: written[2]?.hash })
  assert.equal(events[0]?.prevHash, null)
  assert.equal(events[1]?.prevHash, events[0]?.hash)
  // The Entra ids are stored and hashed in lowercase, whatever case the token had.
  assert.equal(events[0]?.actor.tid, ACTOR.tid.toLowerCase())
  assert.match(events[0]?.at ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
})

test('concurrent appends for one election form one linear chain; two elections chain independently', DB, async (t) => {
  const { db } = await setup(t)
  // More transactions than the pool has connections, each holding its lock a
  // moment after appending: without the lock, two would read the same head.
  const append = (electionId: string, n: number) => db.tx(async (client) => {
    await appendAudit(client, electionId, invited(n))
    await client.query('select pg_sleep(0.01)')
  })
  await Promise.all(Array.from({ length: 24 }, (_, n) => append(n % 2 === 0 ? ELECTION_A : ELECTION_B, n)))

  for (const electionId of [ELECTION_A, ELECTION_B]) {
    const events = await chainOf(db, electionId)
    assert.equal(verifyAuditChain(events).valid, true)
    assert.equal(events.length, 12)
    assert.ok(events.every((event) => event.electionId === electionId))
  }
})

test('a rolled-back transaction leaves no event, and the chain goes on from the last committed one', DB, async (t) => {
  const { db } = await setup(t)
  const first = await db.tx((client) => appendAudit(client, ELECTION_A, invited(1)))
  await assert.rejects(db.tx(async (client) => {
    await appendAudit(client, ELECTION_A, invited(2))
    throw new Error('the change failed')
  }), /the change failed/)
  assert.deepEqual(await chainOf(db, ELECTION_A), [first])
  const next = await db.tx((client) => appendAudit(client, ELECTION_A, invited(3)))
  assert.equal(next.prevHash, first.hash)
})

test('metadata outside the allow-list, or a malformed actor or election, is refused and nothing is written', DB, async (t) => {
  const { db } = await setup(t)
  const refused: [string, unknown, unknown][] = [
    ['unknown key', ELECTION_A, { ...invited(1), metadata: { upn: 'a@school.example', role: 'witness', key: 'ABCD-EFGH-JKLM' } }],
    ['missing key', ELECTION_A, { ...invited(1), metadata: { upn: 'a@school.example' } }],
    ['wrong type', ELECTION_A, { ...invited(1), metadata: { upn: 7, role: 'witness' } }],
    ['unknown action', ELECTION_A, { ...invited(1), action: 'ballot.cast', metadata: {} }],
    ['actor without object id', ELECTION_A, { ...invited(1), actor: { tid: ACTOR.tid, name: 'X' } }],
    ['actor without name', ELECTION_A, { ...invited(1), actor: { ...ACTOR, name: '' } }],
    ['election id', 'not-a-uuid', invited(1)],
  ]
  for (const [label, electionId, input] of refused) {
    await assert.rejects(
      db.tx((client) => appendAudit(client, electionId as string, input as AuditInput<'member.invited'>)),
      (err: Error) => err instanceof AuditError,
      label,
    )
  }
  const { rows } = await db.query<{ n: string }>('select count(*) as n from audit_event')
  assert.equal(rows[0]?.n, '0')
})

test('appendAudit refuses to run outside a transaction, or in one that does not read committed data', DB, async (t) => {
  const { db, runtimeUrl } = await setup(t)
  await withClient(runtimeUrl, async (client) => {
    await assert.rejects(appendAudit(client, ELECTION_A, invited(1)), /must run inside the transaction/)
    await client.query('begin isolation level repeatable read')
    await assert.rejects(appendAudit(client, ELECTION_A, invited(1)), /needs a READ COMMITTED transaction/)
    await client.query('rollback')
  })
  assert.deepEqual(await chainOf(db, ELECTION_A), [])
})

test('editing a stored event breaks verification; relinking or removing one is refused by the database', DB, async (t) => {
  const { db, ownerUrl } = await setup(t)
  for (let n = 0; n < 3; n++) await db.tx((client) => appendAudit(client, ELECTION_A, invited(n)))
  const [, middle] = await chainOf(db, ELECTION_A)
  assert.ok(middle)

  // Even the owner, who may change rows, cannot change one unnoticed.
  const edits = [
    'set action = \'member.removed\'',
    'set metadata = jsonb_set(metadata, \'{role}\', \'"admin"\')',
    'set metadata = metadata || \'{"note": "added"}\'',
    'set actor_name = \'Someone Else\'',
    'set actor_oid = gen_random_uuid()',
    'set at = at + interval \'1 millisecond\'',
  ]
  await withClient(ownerUrl, async (client) => {
    for (const edit of edits) {
      await client.query('begin')
      await client.query(`update audit_event ${edit} where seq = $1`, [middle.seq])
      const status = verifyAuditChain(await readAuditChain(client, ELECTION_A))
      await client.query('rollback')
      assert.deepEqual(status, { valid: false, length: 3, index: 1, problem: 'hash-mismatch' }, edit)
    }
    // The links themselves are held by the database: an event that another
    // names as its predecessor cannot be removed or given another hash.
    for (const statement of ['delete from audit_event where seq = $1', 'update audit_event set hash = repeat(\'0\', 64) where seq = $1']) {
      await assert.rejects(client.query(statement, [middle.seq]), (err) => sqlState(err) === '23503', statement)
    }
  })
  assert.equal(verifyAuditChain(await chainOf(db, ELECTION_A)).valid, true)
})

test('the database keeps every chain linear: one first event, no forks, no foreign links', DB, async (t) => {
  const { db, runtimeUrl } = await setup(t)
  const first = await db.tx((client) => appendAudit(client, ELECTION_A, invited(1)))
  await db.tx((client) => appendAudit(client, ELECTION_A, invited(2)))
  const other = await db.tx((client) => appendAudit(client, ELECTION_B, invited(3)))

  const insert = `insert into audit_event (election_id, at, actor_tid, actor_oid, actor_name, action, metadata, prev_hash, hash)
    values ($1, now()::timestamp(3), $2, $3, 'X', 'member.invited', '{}', $4, $5)`
  const attempts: [string, string, string | null, string][] = [
    ['a second first event', '23505', null, ELECTION_A],
    ['a fork from the first event', '23505', first.hash, ELECTION_A],
    ['a link to a missing event', '23503', 'e'.repeat(64), ELECTION_A],
    ['a link into another election', '23503', other.hash, ELECTION_A],
  ]
  await withClient(runtimeUrl, async (client) => {
    for (const [label, code, prevHash, electionId] of attempts) {
      await assert.rejects(
        client.query(insert, [electionId, ACTOR.tid, ACTOR.oid, prevHash, 'd'.repeat(64)]),
        (err) => sqlState(err) === code,
        label,
      )
    }
  })
})

test('the runtime role can add and read events but never change or remove them', DB, async (t) => {
  const { db, runtimeUrl } = await setup(t)
  await db.tx((client) => appendAudit(client, ELECTION_A, invited(1)))
  await withClient(runtimeUrl, async (client) => {
    const { rows } = await client.query<Record<string, boolean>>(
      `select ${['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']
        .map((privilege) => `has_table_privilege('audit_event', '${privilege}') as ${privilege}`).join(', ')}`,
    )
    assert.deepEqual(rows[0], { select: true, insert: true, update: false, delete: false, truncate: false, references: false, trigger: false })
    for (const statement of ['update audit_event set actor_name = \'X\'', 'delete from audit_event', 'truncate audit_event']) {
      await assert.rejects(client.query(statement), (err) => sqlState(err) === '42501', statement)
    }
  })
  assert.equal((await chainOf(db, ELECTION_A)).length, 1)
})

test('the upgrade fixture is a genuine chain, and the stored events read back as they were hashed', DB, async (t) => {
  const { db, ownerUrl } = await setup(t)
  const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/upgrade/0003.sql')
  const sql = await readFile(fixture, 'utf8')
  await withClient(ownerUrl, (client) => client.query(sql))
  const events = await chainOf(db, '0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30')
  assert.deepEqual(verifyAuditChain(events), { valid: true, length: 2, head: 'ba962248b19e7ba197012fc1e41358c9473159f1a83428ac3b07ecf7a97474ca' })
})
