import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUDIT_ACTION, MAX_ACTION } from '../lib/audit-chain.ts'
import { AUDIT_ACTIONS, AuditError, auditMetadata } from '../lib/audit.ts'

const CONTEST = '5b4dae30-7c6f-4081-9d9c-2e3f4a5b6c7d'

test('metadata must match its action exactly: known fields, each of its type', () => {
  assert.deepEqual(auditMetadata('election.created', { title: 'Wahl' }), { title: 'Wahl' })
  assert.deepEqual(auditMetadata('contest.removed', { contest: CONTEST.toUpperCase(), title: 'T', candidates: 0 }), { contest: CONTEST, title: 'T', candidates: 0 })
  assert.deepEqual(auditMetadata('election.updated', { title: 'T', description: 'x'.repeat(2000) }), { title: 'T', description: 'x'.repeat(2000) })
  // A description is counted in code points, as the API and the database count it.
  const emoji = `${'x'.repeat(1999)}🎉`
  assert.deepEqual(auditMetadata('election.updated', { title: 'T', description: emoji }), { title: 'T', description: emoji })
  assert.deepEqual(auditMetadata('election.unprepared', {}), {})
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
    ['contest.created', { contest: 'not-an-id', title: 'T', rulesetId: 'single-choice-v1' }, /metadata field contest must be a UUID$/],
    ['contest.created', { contest: CONTEST, title: 'T', rulesetId: 'at-mayor-v1' }, /metadata field rulesetId must be one of at-school-speaker-v1, at-representative-v1, single-choice-v1$/],
    ['contest.removed', { contest: CONTEST, title: 'T', candidates: -1 }, /metadata field candidates must be a non-negative safe integer$/],
    ['contest.removed', { contest: CONTEST, title: 'T', candidates: 1.5 }, /must be a non-negative safe integer$/],
    ['contest.removed', { contest: CONTEST, title: 'T', candidates: '2' }, /must be a non-negative safe integer$/],
    ['election.updated', { title: 'T', description: 'x'.repeat(2001) }, /metadata field description must be well-formed text of 0 to 2000 characters$/],
    ['election.updated', { title: 'T', description: `${'x'.repeat(2000)}🎉` }, /metadata field description must be well-formed text/],
    ['election.unprepared', { reason: 'x' }, /metadata field reason is not allowed$/],
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
