import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, describeDatabase } from '../../lib/db.ts'
import { buildTestApp } from '../helpers/app.ts'
import { createTestDatabase, dbTest } from '../helpers/db.ts'

dbTest('tx commits on success, rolls back on throw and always releases the client', async (t) => {
  const testDb = await createTestDatabase(t)
  const db = createDatabase(testDb.ownerUrl, () => {})
  t.after(() => db.close())
  await db.query('create table counter (n int)')

  await db.tx((client) => client.query('insert into counter values (1)'))
  // More failing transactions than the pool has clients: a client that was
  // not released would make the next connect wait until its timeout.
  for (let i = 0; i < 12; i++) {
    await assert.rejects(db.tx(async (client) => {
      await client.query('insert into counter values (2)')
      throw new Error('abort')
    }), /abort/)
  }
  const { rows } = await db.query<{ n: number }>('select n from counter')
  assert.deepEqual(rows, [{ n: 1 }])
})

test('health reports the database as down when it cannot connect', async (t) => {
  const db = createDatabase('postgres://nobody:pw@127.0.0.1:1/none', () => {})
  const { app } = await buildTestApp({}, db)
  t.after(async () => {
    await app.close()
    await db.close()
  })
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.json(), { status: 'degraded', db: 'down' })
})

dbTest('health reports the database as up', async (t) => {
  const testDb = await createTestDatabase(t)
  const db = createDatabase(testDb.runtimeUrl, () => {})
  const { app } = await buildTestApp({}, db)
  t.after(async () => {
    await app.close()
    await db.close()
  })
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/health' })).json(), { status: 'ok', db: 'up' })
})

test('log lines name the database without its password', () => {
  assert.equal(describeDatabase('postgres://app:s3cret@db.internal:5432/school_election'), 'app@db.internal:5432/school_election')
})
