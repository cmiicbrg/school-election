import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditEventHash, verifyAuditChain, type AuditEvent, type AuditEventContent } from '../lib/audit-chain.ts'

const ELECTION = '0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a30'
const ACTOR = { tid: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', oid: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', name: 'Maria Huber' }

/** A genuine chain of `n` events, as appendAudit would have written it. */
function chain(n: number, electionId = ELECTION, firstSeq = 1): AuditEvent[] {
  const events: AuditEvent[] = []
  for (let i = 0; i < n; i++) {
    const content: AuditEventContent = {
      electionId,
      at: new Date(Date.UTC(2026, 9, 5, 8, 0, i)).toISOString(),
      actor: ACTOR,
      action: 'member.invited',
      metadata: { email: `member${i}@school.example`, role: 'witness' },
      prevHash: events.at(-1)?.hash ?? null,
    }
    events.push({ seq: firstSeq + 2 * i, ...content, hash: auditEventHash(content) })
  }
  return events
}

test('the hash is SHA-256 over a fixed canonical record, so another implementation can recompute it', () => {
  // Expected values checked with `printf '%s' '<record>' | sha256sum`, where
  // the record is the canonical JSON in the comment of lib/audit-chain.ts.
  const first: AuditEventContent = {
    electionId: ELECTION,
    at: '2026-10-05T07:45:12.345Z',
    actor: ACTOR,
    action: 'election.created',
    metadata: { title: 'Schulsprecherwahl 2026/27' },
    prevHash: null,
  }
  assert.equal(auditEventHash(first), 'b6022b1fc84736cd665f1d8fec5926ca1d82bfcb1c9e51896c5350a3d34fe2cc')
  const second: AuditEventContent = {
    ...first,
    at: '2026-10-05T07:46:03.001Z',
    action: 'member.invited',
    metadata: { email: 'witness@school.example', role: 'witness' },
    prevHash: 'b6022b1fc84736cd665f1d8fec5926ca1d82bfcb1c9e51896c5350a3d34fe2cc',
  }
  assert.equal(auditEventHash(second), '7827d380b44d772cbfee0ecf7bb7189ab5d24c5255a70752db1489e0aa166ed6')
})

test('a genuine chain verifies and reports its head; an empty one is valid', () => {
  const events = chain(4)
  assert.deepEqual(verifyAuditChain(events), { valid: true, length: 4, head: events[3]?.hash })
  assert.deepEqual(verifyAuditChain([]), { valid: true, length: 0, head: null })
})

test('editing any hashed field breaks verification at that event', () => {
  const edits: Record<string, (event: AuditEvent) => AuditEvent> = {
    'election': (e) => ({ ...e, electionId: '0b9e4a52-3c1d-4f7e-9a6b-2d8c5e1f7a31' }),
    'time': (e) => ({ ...e, at: '2026-10-05T08:00:01.001Z' }),
    'actor tenant': (e) => ({ ...e, actor: { ...e.actor, tid: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4c' } }),
    'actor object id': (e) => ({ ...e, actor: { ...e.actor, oid: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6e' } }),
    'actor name': (e) => ({ ...e, actor: { ...e.actor, name: 'Someone Else' } }),
    'action': (e) => ({ ...e, action: 'member.removed' }),
    'metadata value': (e) => ({ ...e, metadata: { ...e.metadata, role: 'admin' } }),
    'metadata key added': (e) => ({ ...e, metadata: { ...e.metadata, note: 'x' } }),
    'metadata key removed': (e) => ({ ...e, metadata: { email: e.metadata.email ?? null } }),
    'stored hash': (e) => ({ ...e, hash: 'f'.repeat(64) }),
  }
  for (const [field, edit] of Object.entries(edits)) {
    const events = chain(3)
    events[1] = edit(events[1] as AuditEvent)
    const status = verifyAuditChain(events)
    assert.equal(status.valid, false, field)
    // An edited election id is caught as a foreign event before its hash.
    const problem = field === 'election' ? 'wrong-election' : 'hash-mismatch'
    assert.deepEqual(status, { valid: false, length: 3, index: 1, problem }, field)
  }
})

test('an edited event with a recomputed hash breaks the link from the next event', () => {
  const events = chain(3)
  const forged = { ...(events[1] as AuditEvent), metadata: { email: 'someone@school.example', role: 'admin' } }
  events[1] = { ...forged, hash: auditEventHash(forged) }
  assert.deepEqual(verifyAuditChain(events), { valid: false, length: 3, index: 2, problem: 'broken-link' })
})

test('removing, inserting or reordering events breaks verification', () => {
  const events = chain(4)
  const [e0, e1, e2, e3] = events as [AuditEvent, AuditEvent, AuditEvent, AuditEvent]
  assert.deepEqual(verifyAuditChain([e0, e2, e3]), { valid: false, length: 3, index: 1, problem: 'broken-link' })
  assert.deepEqual(verifyAuditChain([e1, e2, e3]), { valid: false, length: 3, index: 0, problem: 'broken-link' })
  assert.deepEqual(verifyAuditChain([e0, e2, e1, e3]), { valid: false, length: 4, index: 1, problem: 'broken-link' })
  // seq is not hashed, but must still increase along the chain.
  assert.deepEqual(verifyAuditChain([e0, { ...e1, seq: e0.seq }, e2]), { valid: false, length: 3, index: 1, problem: 'out-of-order' })
  // A forged first event with a valid hash still does not lead to the rest.
  const genesis = { ...e0, metadata: { email: 'forged@school.example', role: 'witness' } }
  assert.deepEqual(verifyAuditChain([{ ...genesis, hash: auditEventHash(genesis) }, e1]), { valid: false, length: 2, index: 1, problem: 'broken-link' })
})

test('events of two elections are two chains, never one', () => {
  const a = chain(2)
  const b = chain(2, '7d1f3e5a-9b2c-4d6e-8f0a-1b3c5d7e9f20', 10)
  assert.equal(verifyAuditChain(b).valid, true)
  assert.deepEqual(verifyAuditChain([...a, ...b]), { valid: false, length: 4, index: 2, problem: 'wrong-election' })
})

test('a shortened chain, or one rewritten with every later hash recomputed, verifies: only a recorded head shows it', () => {
  const events = chain(3)
  const recordedHead = events[2]?.hash
  const shorter = verifyAuditChain(events.slice(0, 2))
  assert.equal(shorter.valid, true)
  assert.notEqual(shorter.valid && shorter.head, recordedHead)

  // The hashes are not signed: rewrite the middle event and rehash onwards.
  const rewritten: AuditEvent[] = [events[0] as AuditEvent]
  for (const event of events.slice(1)) {
    const content = { ...event, prevHash: rewritten.at(-1)?.hash ?? null }
    if (event === events[1]) content.metadata = { email: 'someone@school.example', role: 'admin' }
    rewritten.push({ ...content, hash: auditEventHash(content) })
  }
  const status = verifyAuditChain(rewritten)
  assert.equal(status.valid, true)
  assert.notEqual(status.valid && status.head, recordedHead)
})

test('input that is not an event is reported as malformed, never thrown', () => {
  const [event] = chain(1) as [AuditEvent]
  const malformed: unknown[] = [
    null,
    'event',
    [],
    { ...event, seq: '1' },
    { ...event, seq: 1.5 },
    { ...event, seq: 0 },
    { ...event, seq: -1 },
    // Values the server never writes, even with a hash recomputed to match.
    ...[
      { electionId: 'election-1' },
      { electionId: event.electionId.toUpperCase() },
      { at: 'yesterday' },
      { at: '2026-10-05T08:00:00Z' },
      { at: '2026-02-30T08:00:00.000Z' },
      { at: '2026-10-05T24:00:00.000Z' },
      { actor: { ...event.actor, tid: '' } },
      { actor: { ...event.actor, oid: 'not-an-oid' } },
      { actor: { ...event.actor, name: '' } },
      { actor: { ...event.actor, name: 'x'.repeat(257) } },
      { action: 'Member.Invited' },
      { action: 'member..invited' },
      { action: `member.${'x'.repeat(64)}` },
      { prevHash: 'abc' },
    ].map((change) => {
      const content = { ...event, ...change }
      return { ...content, hash: auditEventHash(content) }
    }),
    { ...event, hash: event.hash.toUpperCase() },
    { ...event, at: Date.parse(event.at) },
    { ...event, actor: null },
    { ...event, actor: { ...event.actor, name: undefined } },
    { ...event, metadata: [] },
    { ...event, metadata: { count: 0.5 } },
    { ...event, metadata: { when: new Date(0) } },
    { ...event, prevHash: undefined },
    { ...event, hash: null },
    { ...event, at: 'lone \uD800 surrogate' },
  ]
  for (const value of malformed) {
    assert.deepEqual(verifyAuditChain([value]), { valid: false, length: 1, index: 0, problem: 'malformed' }, JSON.stringify(value))
  }
  // The root of an export may be anything, too.
  const unreadable = new Proxy([event], {
    get: () => {
      throw new Error('read refused')
    },
  })
  for (const root of [null, undefined, {}, 'events', 1, { 0: event, length: 1 }, unreadable]) {
    assert.deepEqual(verifyAuditChain(root), { valid: false, length: 0, index: 0, problem: 'malformed' }, typeof root)
  }
  assert.deepEqual(verifyAuditChain([event, , event]), { valid: false, length: 3, index: 1, problem: 'malformed' })
})

test('the events are read by index, never through an iterator the input supplies', () => {
  const genuine = chain(2)
  const [first, second] = genuine as [AuditEvent, AuditEvent]
  const tampered = Object.defineProperty([{ ...first, action: 'member.removed' }, second], Symbol.iterator, {
    value: () => genuine[Symbol.iterator](),
  })
  assert.deepEqual(verifyAuditChain(tampered), { valid: false, length: 2, index: 0, problem: 'hash-mismatch' })
  // A hole is not filled from the prototype either.
  const inherited: unknown = Object.setPrototypeOf([, second], Object.assign(Object.create(Array.prototype) as object, { 0: first }))
  assert.deepEqual(verifyAuditChain(inherited), { valid: false, length: 2, index: 0, problem: 'malformed' })
})

test('fields that are not hashed are refused, so nothing in a valid chain goes unverified', () => {
  const [event] = chain(1) as [AuditEvent]
  const { seq: _seq, ...withoutSeq } = event
  for (const value of [{ ...event, approved: true }, { ...event, actor: { ...event.actor, token: 'x' } }, withoutSeq]) {
    assert.deepEqual(verifyAuditChain([value]), { valid: false, length: 1, index: 0, problem: 'malformed' }, JSON.stringify(value))
  }
  // Hidden from JSON, but still not part of the hash.
  const hidden = Object.defineProperty({ ...event }, 'note', { value: 'x', enumerable: false })
  assert.deepEqual(verifyAuditChain([hidden]), { valid: false, length: 1, index: 0, problem: 'malformed' })
})

test('an event that throws while being read is malformed, and one that changes between reads is read once', () => {
  const [first, second] = chain(2) as [AuditEvent, AuditEvent]
  const fail = (): never => {
    throw new Error('read refused')
  }
  const throwing = { ...first, metadata: Object.defineProperty({}, 'role', { get: fail, enumerable: true }) }
  const proxy = new Proxy(first, { ownKeys: fail })
  for (const value of [throwing, proxy]) {
    assert.deepEqual(verifyAuditChain([value]), { valid: false, length: 1, index: 0, problem: 'malformed' })
  }
  // A hash that reads correctly once and differently afterwards is checked,
  // and linked to, as it was read the first time.
  let reads = 0
  const shifty = Object.defineProperty({ ...first }, 'hash', { get: () => (reads++ === 0 ? first.hash : 'f'.repeat(64)), enumerable: true })
  assert.deepEqual(verifyAuditChain([shifty, second]), { valid: true, length: 2, head: second.hash })
})
