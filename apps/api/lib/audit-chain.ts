// The hash chain of the administrative audit log, and its verification.
// Pure: it imports node:crypto and canonical JSON and nothing else (ESLint
// enforces it), so the offline verifier recomputes exactly what the server
// wrote, without a database.
//
// Each election has its own chain. An event's hash is the SHA-256, in
// lowercase hex, of the canonical JSON of
//
//   { version: 1, electionId, at, actor: { tid, oid, name }, action, metadata, prevHash }
//
// where prevHash is the hash of the election's previous event, and null for
// its first. Changing, inserting, removing or reordering an event breaks
// verification at that event or the one after it, unless every later hash
// is recomputed as well. The hashes are not signed: whoever can change the
// table (the database owner; the application's role can only add events)
// can rewrite the history from any event on, or drop the newest events, and
// the chain still verifies, only with a different head. Verification
// therefore vouches for the history up to a head hash recorded outside the
// database and compared with it, such as in a result, an export or the
// witnesses' notes.

import { createHash } from 'node:crypto'
import { canonicalJson, type CanonicalValue } from './canonical-json.ts'

/** Part of every hashed record; a change to what is hashed gets a new version. */
export const AUDIT_CHAIN_VERSION = 1

/** Who acted: the stable Entra identity (tenant and object id) and the name shown for it. */
export interface AuditActor {
  tid: string
  oid: string
  name: string
}

export type AuditMetadata = Readonly<Record<string, CanonicalValue>>

export interface AuditEvent {
  /** Position in the whole log; increases along every chain, with gaps. */
  seq: number
  electionId: string
  /** ISO 8601 in UTC with milliseconds, as Date.prototype.toISOString writes it. */
  at: string
  actor: AuditActor
  action: string
  metadata: AuditMetadata
  prevHash: string | null
  hash: string
}

export type AuditEventContent = Omit<AuditEvent, 'seq' | 'hash'>

/** Throws CanonicalJsonError for content that has no canonical form. */
export function auditEventHash(event: AuditEventContent): string {
  const record = {
    version: AUDIT_CHAIN_VERSION,
    electionId: event.electionId,
    at: event.at,
    actor: { tid: event.actor.tid, oid: event.actor.oid, name: event.actor.name },
    action: event.action,
    metadata: event.metadata,
    prevHash: event.prevHash,
  }
  return createHash('sha256').update(canonicalJson(record)).digest('hex')
}

/**
 * What is wrong with an event:
 * - malformed: not an event; a field is missing, has the wrong type or has no canonical form;
 * - wrong-election: it belongs to another election than the event before it;
 * - out-of-order: its seq does not increase;
 * - broken-link: it does not name the event before it as its predecessor;
 * - hash-mismatch: its content does not give its hash.
 */
export type AuditChainProblem = 'malformed' | 'wrong-election' | 'out-of-order' | 'broken-link' | 'hash-mismatch'

export interface ValidAuditChain {
  valid: true
  length: number
  /** The newest event's hash: compare it with one recorded elsewhere to detect a rewritten or shortened history. */
  head: string | null
}

export interface BrokenAuditChain {
  valid: false
  length: number
  /** The first event with a problem. */
  index: number
  problem: AuditChainProblem
}

export type AuditChainStatus = ValidAuditChain | BrokenAuditChain

/**
 * Checks one election's events, in seq order: each names its predecessor and
 * hashes to its stored hash. Reports the first problem by its index. Accepts
 * any input, since an export may have been altered: whatever is not exactly
 * an event, or throws while being read, is malformed, and so is anything but
 * an array of events (reported at index 0).
 */
export function verifyAuditChain(events: unknown): AuditChainStatus {
  const list = readList(events)
  if (!list) return { valid: false, length: 0, index: 0, problem: 'malformed' }
  let previous: AuditEvent | undefined
  for (const [index, value] of list.entries()) {
    const read = readEvent(value)
    const problem = read ? linkProblem(read, previous) : 'malformed'
    if (problem) return { valid: false, length: list.length, index, problem }
    previous = read?.event
  }
  return { valid: true, length: list.length, head: previous?.hash ?? null }
}

/** A copy of the array, its holes as undefined; undefined for anything else. */
function readList(value: unknown): unknown[] | undefined {
  try {
    return Array.isArray(value) ? [...(value as unknown[])] : undefined
  } catch {
    // A proxy that refuses to be read.
    return undefined
  }
}

const EVENT_KEYS = ['seq', 'electionId', 'at', 'actor', 'action', 'metadata', 'prevHash', 'hash']
const ACTOR_KEYS = ['tid', 'oid', 'name']

interface ReadEvent {
  event: AuditEvent
  computedHash: string
}

/**
 * A plain copy of an event, every field read once, with the hash of its
 * content; undefined unless the value has exactly the fields of an event,
 * each of its type. An extra field would pass verification without being
 * hashed, and a getter or proxy could answer differently on a second read.
 */
function readEvent(value: unknown): ReadEvent | undefined {
  try {
    if (!hasExactly(value, EVENT_KEYS)) return undefined
    const { seq, electionId, at, actor, action, metadata, prevHash, hash } = value
    if (!hasExactly(actor, ACTOR_KEYS)) return undefined
    const { tid, oid, name } = actor
    const copy = { seq, electionId, at, actor: { tid, oid, name }, action, metadata: JSON.parse(canonicalJson(metadata)) as unknown, prevHash, hash }
    return isEvent(copy) ? { event: copy, computedHash: auditEventHash(copy) } : undefined
  } catch {
    // A throwing getter or proxy, or a value without a canonical form.
    return undefined
  }
}

function linkProblem({ event, computedHash }: ReadEvent, previous: AuditEvent | undefined): AuditChainProblem | undefined {
  if (previous && event.electionId !== previous.electionId) return 'wrong-election'
  if (previous && event.seq <= previous.seq) return 'out-of-order'
  if (event.prevHash !== (previous?.hash ?? null)) return 'broken-link'
  return computedHash === event.hash ? undefined : 'hash-mismatch'
}

type Unchecked<T> = { [K in keyof T]: unknown }

function isEvent(value: Unchecked<Omit<AuditEvent, 'actor'>> & { actor: Unchecked<AuditActor> }): value is AuditEvent {
  const { actor, metadata, seq } = value
  // seq comes from an identity column, which starts at 1.
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 1
    && typeof value.electionId === 'string'
    && typeof value.at === 'string'
    && typeof actor.tid === 'string'
    && typeof actor.oid === 'string'
    && typeof actor.name === 'string'
    && typeof value.action === 'string'
    && typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    && (value.prevHash === null || typeof value.prevHash === 'string')
    && typeof value.hash === 'string'
}

/** An object whose own keys, enumerable or not, are exactly `keys`. */
function hasExactly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && keys.every((key) => own.includes(key))
}
