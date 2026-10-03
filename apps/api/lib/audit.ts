// The administrative audit log: who did what to an election, and when.
// appendAudit writes an event in the transaction of the change it records,
// so the change and its record commit or roll back together.
//
// It records administrators' actions only, never voter activity: no ballot
// or ballot content, no voting key or credential, no use of an entitlement,
// no voter session, token or request metadata. Every action has a fixed set
// of metadata fields, each with a type, and anything else is refused, so a
// caller cannot slip such a value into the log by accident. Each feature
// adds the actions it writes, with their fields, to AUDIT_ACTIONS.

import type pg from 'pg'
import { auditEventHash, MAX_ACTOR_NAME, type AuditActor, type AuditEvent, type AuditMetadata } from './audit-chain.ts'
import { INVITED_ROLES } from './permissions.ts'

/**
 * A metadata field: free text of at most 1000 UTF-16 code units, or one of a
 * fixed list of strings. Further types (a count, an id) come with the first
 * action that needs them.
 */
export type AuditField = 'text' | readonly [string, ...string[]]

/**
 * Every action the log accepts, with exactly the metadata fields it carries.
 * The first ones are creating an election and managing its members.
 */
export const AUDIT_ACTIONS = {
  'election.created': { title: 'text' },
  // The actor of member.bound is the invited person on their first sign-in,
  // so the event names the Entra identity the invitation was bound to.
  'member.invited': { email: 'text', role: INVITED_ROLES },
  'member.bound': { email: 'text', role: INVITED_ROLES },
  'member.removed': { email: 'text', role: INVITED_ROLES },
} as const satisfies Readonly<Record<string, Readonly<Record<string, AuditField>>>>

export type AuditAction = keyof typeof AUDIT_ACTIONS

type FieldValue<F> = F extends readonly (infer V)[] ? V : string

export type AuditMetadataOf<A extends AuditAction> = {
  -readonly [K in keyof (typeof AUDIT_ACTIONS)[A]]: FieldValue<(typeof AUDIT_ACTIONS)[A][K]>
}

export interface AuditInput<A extends AuditAction> {
  actor: AuditActor
  action: A
  metadata: AuditMetadataOf<A>
}

/** A call that breaks the audit contract: a programming error, never a user error. */
export class AuditError extends Error {
  override name = 'AuditError'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXT = 1000

// Two-key advisory locks (a key space of their own, apart from one-key
// locks such as the migrator's): a fixed class for the audit log and the
// first 32 bits of the election id. Elections that share those bits only
// wait for each other; their chains stay separate.
const LOCK_CLASS = 0x41554454

/**
 * Appends one event to the election's chain, inside the caller's open
 * transaction on `client`. A per-election lock, held until that transaction
 * ends, makes concurrent appends wait for each other, so every chain stays
 * linear. The transaction must be READ COMMITTED (the default), so that the
 * chain head read under the lock is the newest committed event.
 */
export async function appendAudit<A extends AuditAction>(
  client: pg.ClientBase,
  electionId: string,
  input: AuditInput<A>,
): Promise<AuditEvent> {
  // Outside a transaction block the lock would end with its own statement,
  // and the event would commit apart from the change it records.
  if (client.getTransactionStatus() !== 'T') {
    throw new AuditError('appendAudit must run inside the transaction of the change it records')
  }
  const election = uuid(electionId, 'electionId')
  const actor = auditActor(input.actor)
  const action: string = input.action
  const metadata = auditMetadata(action, input.metadata)

  await lockElection(client, election)
  // The time is taken under the lock, so it follows the chain order (as long
  // as the server clock does not go back), and in whole milliseconds, which
  // a JavaScript Date and the hashed ISO 8601 text hold exactly.
  const head = await client.query<{ at: Date, prev_seq: string | null, prev_hash: string | null }>(
    `select date_trunc('milliseconds', clock_timestamp()) as at, head.seq as prev_seq, head.hash as prev_hash
       from (select 1) as one
       left join (select seq, hash from audit_event where election_id = $1 order by seq desc limit 1) as head on true`,
    [election],
  )
  const row = head.rows[0]
  if (!row) throw new AuditError('reading the chain head returned no row')
  const content = { electionId: election, at: row.at.toISOString(), actor, action, metadata, prevHash: row.prev_hash }
  const hash = auditEventHash(content)
  const inserted = await client.query<{ seq: string }>(
    `insert into audit_event (election_id, at, actor_tid, actor_oid, actor_name, action, metadata, prev_seq, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning seq`,
    [election, content.at, actor.tid, actor.oid, actor.name, action, JSON.stringify(metadata), row.prev_seq, content.prevHash, hash],
  )
  return { seq: toSeq(inserted.rows[0]?.seq), ...content, hash }
}

/**
 * Takes the election's lock until the open transaction on `client` ends.
 * Every change to an election takes it before it reads what it changes, and
 * appendAudit takes it (again; the lock is reentrant) before reading the
 * chain head, so changes to one election and their events happen one after
 * another. The transaction must be READ COMMITTED (the default), so that
 * what it reads after the lock is the newest committed state.
 */
export async function lockElection(client: pg.ClientBase, electionId: string): Promise<void> {
  if (client.getTransactionStatus() !== 'T') {
    throw new AuditError('the election lock is only held inside a transaction')
  }
  const lock = await client.query<{ isolation: string }>(
    'select current_setting(\'transaction_isolation\') as isolation from pg_advisory_xact_lock($1, $2)',
    [LOCK_CLASS, lockKey(uuid(electionId, 'electionId'))],
  )
  if (lock.rows[0]?.isolation !== 'read committed') {
    throw new AuditError('the election lock needs a READ COMMITTED transaction to see the newest committed state')
  }
}

interface AuditEventRow {
  seq: string
  election_id: string
  at: Date
  actor_tid: string
  actor_oid: string
  actor_name: string
  action: string
  metadata: AuditMetadata
  prev_hash: string | null
  hash: string
}

/** One election's events in chain order, ready for verifyAuditChain. */
export async function readAuditChain(client: pg.ClientBase, electionId: string): Promise<AuditEvent[]> {
  const { rows } = await client.query<AuditEventRow>(
    `select seq, election_id, at, actor_tid, actor_oid, actor_name, action, metadata, prev_hash, hash
       from audit_event where election_id = $1 order by seq`,
    [uuid(electionId, 'electionId')],
  )
  return rows.map((row) => ({
    seq: toSeq(row.seq),
    electionId: row.election_id,
    at: row.at.toISOString(),
    actor: { tid: row.actor_tid, oid: row.actor_oid, name: row.actor_name },
    action: row.action,
    metadata: row.metadata,
    prevHash: row.prev_hash,
    hash: row.hash,
  }))
}

/** The metadata of an action, checked against its fields; throws AuditError otherwise. */
export function auditMetadata(action: string, metadata: unknown): Record<string, string> {
  if (!Object.hasOwn(AUDIT_ACTIONS, action)) throw new AuditError(`unknown audit action ${action}`)
  const fields: Readonly<Record<string, AuditField>> = AUDIT_ACTIONS[action as AuditAction]
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new AuditError(`${action}: metadata must be an object`)
  }
  const values = metadata as Record<string, unknown>
  const extra = Object.keys(values).find((key) => !Object.hasOwn(fields, key))
  if (extra !== undefined) throw new AuditError(`${action}: metadata field ${extra} is not allowed`)
  const checked: Record<string, string> = {}
  for (const [key, field] of Object.entries(fields)) {
    if (!Object.hasOwn(values, key)) throw new AuditError(`${action}: metadata field ${key} is missing`)
    checked[key] = fieldValue(field, values[key], `${action}: metadata field ${key}`)
  }
  return checked
}

function fieldValue(field: AuditField, value: unknown, label: string): string {
  if (field === 'text') return text(value, MAX_TEXT, label)
  if (typeof value === 'string' && field.includes(value)) return value
  throw new AuditError(`${label} must be one of ${field.join(', ')}`)
}

function auditActor(actor: unknown): AuditActor {
  if (typeof actor !== 'object' || actor === null) throw new AuditError('actor must be an object')
  const { tid, oid, name } = actor as Record<string, unknown>
  return { tid: uuid(tid, 'actor tid'), oid: uuid(oid, 'actor oid'), name: text(name, MAX_ACTOR_NAME, 'actor name', 1) }
}

function uuid(value: unknown, label: string): string {
  if (typeof value === 'string' && UUID.test(value)) return value.toLowerCase()
  throw new AuditError(`${label} must be a UUID`)
}

// Text the log can store and hash unchanged: PostgreSQL holds neither U+0000
// nor a lone surrogate.
function text(value: unknown, max: number, label: string, min = 0): string {
  if (typeof value === 'string' && value.length >= min && value.length <= max && value.isWellFormed() && !value.includes('\0')) {
    return value
  }
  throw new AuditError(`${label} must be well-formed text of ${min} to ${max} characters`)
}

function lockKey(electionId: string): number {
  // The first eight hex digits, as the signed 32-bit integer the lock takes.
  const unsigned = Number.parseInt(electionId.slice(0, 8), 16)
  return unsigned >= 2 ** 31 ? unsigned - 2 ** 32 : unsigned
}

function toSeq(value: string | undefined): number {
  const seq = Number(value)
  if (!Number.isSafeInteger(seq) || seq < 1) throw new AuditError('audit_event.seq is not a safe positive integer')
  return seq
}
