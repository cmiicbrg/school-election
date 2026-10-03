import { test } from 'node:test'
import assert from 'node:assert/strict'
import { upsertAppUser, type EntraIdentity } from '../../lib/app-user.ts'
import { createDatabase } from '../../lib/db.ts'
import { SQLSTATE, sqlState } from '../../lib/pg-errors.ts'
import { createTestDatabase, DB } from '../helpers/db.ts'

const TENANT = '3f2b8c1d-6e4a-4b7f-9c2d-8a1e5f6b7c90'
const OTHER_TENANT = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a'
const person = (changes: Partial<EntraIdentity> = {}): EntraIdentity => ({
  tid: TENANT,
  oid: 'c0ffee00-1234-4abc-8def-0123456789ab',
  displayName: 'Maria Muster',
  upn: 'maria.muster@schule.example.org',
  ...changes,
})

test('a person is the pair (tid, oid): never the upn, never the oid alone', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())

  const maria = await upsertAppUser(db, person())
  assert.equal(await upsertAppUser(db, person({ displayName: 'Maria Neu', upn: null })), maria)
  // The same oid in another directory is someone else.
  const elsewhere = await upsertAppUser(db, person({ tid: OTHER_TENANT }))
  // A upn handed on to someone new does not make them the old holder.
  const successor = await upsertAppUser(db, person({ oid: '0ddba11a-1234-4abc-8def-0123456789ab' }))
  assert.equal(new Set([maria, elsewhere, successor]).size, 3)

  const { rows } = await db.query<{ id: string, display_name: string, upn: string | null }>('select id, display_name, upn from app_user where id = $1', [maria])
  assert.deepEqual(rows, [{ id: maria, display_name: 'Maria Neu', upn: null }])
})

test('the runtime role can neither rewrite an identity nor delete a person', DB, async (t) => {
  const testDb = await createTestDatabase(t)
  const db = createDatabase(testDb.runtimeUrl, () => {})
  t.after(() => db.close())
  const id = await upsertAppUser(db, person())
  for (const sql of ['update app_user set oid = gen_random_uuid() where id = $1', 'update app_user set tid = gen_random_uuid() where id = $1', 'delete from app_user where id = $1']) {
    await assert.rejects(db.query(sql, [id]), (err) => sqlState(err) === SQLSTATE.insufficientPrivilege, sql)
  }
})
