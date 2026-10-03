import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ELECTION_ROLES } from '../../lib/permissions.ts'
import { sqlState } from '../../lib/pg-errors.ts'
import { checkedValues, createTestDatabase, DB, withClient } from '../helpers/db.ts'

const ELECTION = '3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b'

/** A migrated database with one election and one signed-in person, both inserted as the owner. */
async function setup(t: TestContext) {
  const db = await createTestDatabase(t)
  const userId = await withClient(db.ownerUrl, async (client) => {
    await client.query('insert into election (id, title) values ($1, \'Wahl\')', [ELECTION])
    const { rows } = await client.query<{ id: string }>(
      `insert into app_user (tid, oid, display_name, email)
       values ('3f2b8c1d-6e4a-4b7f-9c2d-8a1e5f6b7c90', gen_random_uuid(), 'Anna', 'anna@schule.example.org') returning id`,
    )
    return rows[0]?.id ?? assert.fail('no app_user row')
  })
  return { ...db, userId }
}

// The election states are rows of election_state (migration 0007), which
// test/db/configuration.test.ts compares with the lifecycle.
test('the stored roles are exactly the ones the code knows', DB, async (t) => {
  const { ownerUrl } = await setup(t)
  assert.deepEqual(await checkedValues(ownerUrl, 'election_member', 'role'), [...ELECTION_ROLES])
})

test('every audit event belongs to an election that exists', DB, async (t) => {
  const { runtimeUrl } = await setup(t)
  const insert = `insert into audit_event (election_id, at, actor_tid, actor_oid, actor_name, action, metadata, prev_seq, prev_hash, hash)
    values ($1, now()::timestamp(3), gen_random_uuid(), gen_random_uuid(), 'X', 'election.created', '{}', null, null, $2)`
  await withClient(runtimeUrl, async (client) => {
    await assert.rejects(client.query(insert, ['6c1e8b0a-1d2f-4e3a-9b8c-7d6e5f4a3b2c', 'a'.repeat(64)]), (err) => sqlState(err) === '23503')
    await client.query(insert, [ELECTION, 'b'.repeat(64)])
  })
})

test('members: one owner who is a person, invitations with an address, one per address in any case', DB, async (t) => {
  const { runtimeUrl, userId } = await setup(t)
  const insert = 'insert into election_member (election_id, role, user_id, invited_email) values ($1, $2, $3, $4)'
  await withClient(runtimeUrl, async (client) => {
    const refused: [string, string, string | null, string | null, string][] = [
      ['an owner without a person', 'owner', null, null, '23514'],
      ['an invited owner', 'owner', userId, 'anna@schule.example.org', '23514'],
      ['an invitation without an address', 'witness', null, null, '23514'],
      ['a role that does not exist', 'chair', null, 'x@schule.example.org', '23514'],
    ]
    for (const [label, role, user, email, code] of refused) {
      await assert.rejects(client.query(insert, [ELECTION, role, user, email]), (err) => sqlState(err) === code, label)
    }
    await client.query(insert, [ELECTION, 'owner', userId, null])
    await client.query(insert, [ELECTION, 'witness', null, 'Wanda@Schule.example.org'])
    for (const [label, role, user, email] of [
      ['a second owner', 'owner', userId, null],
      ['the same address in another case', 'admin', null, 'wanda@schule.EXAMPLE.org'],
    ] as const) {
      await assert.rejects(client.query(insert, [ELECTION, role, user, email]), (err) => sqlState(err) === '23505', label)
    }
  })
})

test('an invitation binds once: the runtime role can set the person of a pending one and change nothing else', DB, async (t) => {
  const { runtimeUrl, ownerUrl, userId } = await setup(t)
  await withClient(runtimeUrl, async (client) => {
    const { rows: [member] } = await client.query<{ id: string }>(
      'insert into election_member (election_id, role, invited_email) values ($1, \'witness\', \'anna@schule.example.org\') returning id',
      [ELECTION],
    )
    assert.ok(member)
    await client.query('update election_member set user_id = $1 where id = $2', [userId, member.id])
    for (const statement of ['update election_member set user_id = null where id = $1', 'update election_member set user_id = user_id where id = $1']) {
      await assert.rejects(client.query(statement, [member.id]), (err) => sqlState(err) === '23000', statement)
    }
    for (const statement of ['update election_member set role = \'admin\'', 'update election_member set invited_email = \'x@y.z\'', 'update election set id = gen_random_uuid()', 'delete from election']) {
      await assert.rejects(client.query(statement), (err) => sqlState(err) === '42501', statement)
    }
  })
  // Not even the owner rebinds one.
  await withClient(ownerUrl, async (client) => {
    await assert.rejects(client.query('update election_member set user_id = null'), (err) => sqlState(err) === '23000')
  })
})
