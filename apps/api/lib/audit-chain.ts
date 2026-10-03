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

/** An action name: lowercase words joined by dots, at most MAX_ACTION long, as audit_event requires. */
export const AUDIT_ACTION = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/
export const MAX_ACTION = 64
/** The longest actor name, in UTF-16 code units. */
export const MAX_ACTOR_NAME = 256

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

/**
 * A copy of the array by its length and own elements, holes as undefined;
 * undefined for anything else. The input's iterator is never called: an array
 * can override it to yield a genuine chain while its elements hold another.
 */
function readList(value: unknown): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const { length } = value
    const list: unknown[] = []
    for (let i = 0; i < length; i++) list.push(Object.hasOwn(value, i) ? value[i] : undefined)
    return list
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

/**
 * Only what appendAudit and the audit_event table can produce: a seq from an
 * identity column (from 1), lowercase UUIDs, the time as toISOString writes
 * it, a named actor, a well-formed action, an object of metadata and
 * lowercase hex hashes. A record outside that was not written by the server.
 */
function isEvent(value: Unchecked<Omit<AuditEvent, 'actor'>> & { actor: Unchecked<AuditActor> }): value is AuditEvent {
  const { seq, actor, action, metadata } = value
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 1
    && matches(UUID, value.electionId)
    && isTimestamp(value.at)
    && matches(UUID, actor.tid)
    && matches(UUID, actor.oid)
    && typeof actor.name === 'string' && actor.name.length >= 1 && actor.name.length <= MAX_ACTOR_NAME
    && typeof action === 'string' && action.length <= MAX_ACTION && AUDIT_ACTION.test(action)
    && typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    && (value.prevHash === null || matches(HASH, value.prevHash))
    && matches(HASH, value.hash)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

function matches(pattern: RegExp, value: unknown): boolean {
  return typeof value === 'string' && pattern.test(value)
}

function isTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false
  // A real date in exactly this form: no 30 February, no 24:00.
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value
}

/** An object whose own keys, enumerable or not, are exactly `keys`. */
function hasExactly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && keys.every((key) => own.includes(key))
}
