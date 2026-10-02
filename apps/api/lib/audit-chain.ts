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
// its first. Changing, inserting, removing or reordering an event therefore
// breaks verification at that event or the one after it. Removing events
// from the end leaves a shorter chain that still verifies; only a head hash
// recorded elsewhere, such as in a result or an export, shows that.

import { createHash } from 'node:crypto'
import { canonicalJson, CanonicalJsonError, type CanonicalValue } from './canonical-json.ts'

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
  /** The newest event's hash: record it elsewhere to detect removal from the end. */
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
 * any input, since an export may have been altered.
 */
export function verifyAuditChain(events: readonly unknown[]): AuditChainStatus {
  let previous: AuditEvent | undefined
  for (const [index, event] of events.entries()) {
    const problem = checkEvent(event, previous)
    if (problem) return { valid: false, length: events.length, index, problem }
    previous = event as AuditEvent
  }
  return { valid: true, length: events.length, head: previous?.hash ?? null }
}

function checkEvent(event: unknown, previous: AuditEvent | undefined): AuditChainProblem | undefined {
  if (!isEventShaped(event)) return 'malformed'
  if (previous && event.electionId !== previous.electionId) return 'wrong-election'
  if (previous && event.seq <= previous.seq) return 'out-of-order'
  if (event.prevHash !== (previous?.hash ?? null)) return 'broken-link'
  let hash: string
  try {
    hash = auditEventHash(event)
  } catch (err) {
    if (err instanceof CanonicalJsonError) return 'malformed'
    throw err
  }
  return hash === event.hash ? undefined : 'hash-mismatch'
}

function isEventShaped(value: unknown): value is AuditEvent {
  if (!isRecord(value) || !isRecord(value.actor) || !isRecord(value.metadata)) return false
  const { actor } = value
  return Number.isSafeInteger(value.seq)
    && typeof value.electionId === 'string'
    && typeof value.at === 'string'
    && typeof actor.tid === 'string'
    && typeof actor.oid === 'string'
    && typeof actor.name === 'string'
    && typeof value.action === 'string'
    && (value.prevHash === null || typeof value.prevHash === 'string')
    && typeof value.hash === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
