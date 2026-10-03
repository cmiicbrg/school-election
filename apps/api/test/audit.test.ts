import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUDIT_ACTION, MAX_ACTION } from '../lib/audit-chain.ts'
import { AUDIT_ACTIONS, AuditError, auditMetadata } from '../lib/audit.ts'

test('metadata must match its action exactly: known fields, each of its type', () => {
  assert.deepEqual(auditMetadata('election.created', { title: 'Wahl' }), { title: 'Wahl' })
  assert.deepEqual(auditMetadata('member.invited', { email: 'a@school.example', role: 'admin' }), { email: 'a@school.example', role: 'admin' })
  const rejected: [string, unknown, RegExp][] = [
    ['ballot.cast', {}, /^unknown audit action ballot\.cast$/],
    ['toString', {}, /^unknown audit action toString$/],
    ['election.created', null, /metadata must be an object$/],
    ['election.created', ['Wahl'], /metadata must be an object$/],
    ['election.created', { title: 'Wahl', key: 'ABCD-EFGH' }, /metadata field key is not allowed$/],
    ['election.created', {}, /metadata field title is missing$/],
    ['election.created', { title: 1 }, /metadata field title must be well-formed text of 0 to 1000 characters$/],
    ['election.created', { title: 'x'.repeat(1001) }, /must be well-formed text/],
    ['election.created', { title: 'nul \0' }, /must be well-formed text/],
    ['member.invited', { email: 'a@school.example', role: 'owner' }, /metadata field role must be one of admin, witness$/],
  ]
  for (const [action, metadata, message] of rejected) {
    assert.throws(() => auditMetadata(action, metadata), (err: Error) => err instanceof AuditError && message.test(err.message), action)
  }
})

test('every action name is one the audit_event table and the verifier accept', () => {
  for (const action of Object.keys(AUDIT_ACTIONS)) {
    assert.ok(action.length <= MAX_ACTION && AUDIT_ACTION.test(action), action)
  }
})
