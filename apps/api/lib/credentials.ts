// Voting keys, issued in batches per voter group and round (migration 0008).
//
// The server draws every key from a cryptographically secure generator and
// stores it as generated, so a batch's sheets can be printed again, as
// often as needed, and compared with the database. Reading a batch never
// creates keys: new keys come only from issuing a batch (the first one of a
// group, or a top-up) and from replacing one, which voids the old keys and
// is possible only until the batch's round opens. Each of these is audited
// with its counts; no key ever reaches the audit log, a log line or an
// error message.
//
// Who sees a batch's keys: the owner and co-admins, to print them; a
// witness only once the batch's round has closed, or the election is
// final (which voids the runoff keys of an election that held no runoff),
// with each key used or unused, so the leftover cards can be checked.
// Nobody sees whether a key was used before then. Voters are not members
// and see nothing here.

import type pg from 'pg'
import { canIssueBatch, canRotateBatch, generateKey, KEY_RANDOM_BYTES, type ElectionState, type RoundKind, type RoundState } from '@school-election/election-core'
import { appendAudit } from './audit.ts'
import type { Database } from './db.ts'
import { Refusal, type ElectionAccess } from './election-access.ts'
import { BATCHES_WITH_KEYS } from './batch-keys.ts'
import { compareLabels } from './names.ts'
import { isPermitted, type ElectionRole } from './permissions.ts'
import { sqlState } from './pg-errors.ts'

/** The most keys one batch holds; a group that needs more gets a top-up. */
export const MAX_BATCH_KEYS = 1000

/** A batch is issued, and voided once when it is replaced; the keys of a void batch never vote. */
export const BATCH_STATES = ['issued', 'void'] as const
export type BatchState = typeof BATCH_STATES[number]

export interface BatchSummary {
  id: string
  voterGroupId: string
  roundKind: RoundKind
  state: BatchState
  /** How many keys it holds. */
  keys: number
}

export interface BatchKeys {
  batch: BatchSummary
  /**
   * Its keys, normalised, in key order. used says whether a key cast a
   * ballot: known once the batch's round has closed or the election is
   * final, null before.
   */
  keys: { key: string, used: boolean | null }[]
}

type Queryable = Pick<Database, 'query'>

/** Whether the keys of a batch whose round is in `round` (null: a runoff not activated) are over: nothing of them votes any more. */
export function keysOver(round: RoundState | null, election: ElectionState): boolean {
  return round === 'closed' || election === 'final'
}

/** Whether a member in `role` may read the keys of such a batch. */
export function mayReadKeys(role: ElectionRole, round: RoundState | null, election: ElectionState): boolean {
  return role !== 'witness' || keysOver(round, election)
}

/** Every batch of the election, without keys: by voter group, regular before runoff, issued before void. For every member. */
export async function listBatches(db: Queryable, electionId: string): Promise<BatchSummary[]> {
  const { rows } = await db.query<BatchRow & { group_name: string }>(
    `select b.id, b.voter_group_id, b.round_kind, b.state, b.keys, g.name as group_name
       from ${BATCHES_WITH_KEYS} b join voter_group g on g.id = b.voter_group_id
      where b.election_id = $1`,
    [electionId],
  )
  return rows
    .toSorted((a, b) => compareLabels(a.group_name, b.group_name) || order(a.voter_group_id, b.voter_group_id)
      || order(a.round_kind, b.round_kind) || order(a.state, b.state) || order(a.id, b.id))
    .map(toSummary)
}

/**
 * A batch with its keys, for a member who may read them (403 otherwise,
 * 404 for a batch of another election). Runs in one snapshot: inside
 * changeElection, or in a repeatable-read transaction.
 */
export async function readBatchKeys(db: Queryable, access: Pick<ElectionAccess, 'electionId' | 'role'>, batchId: string): Promise<BatchKeys> {
  const { rows: [row] } = await db.query<BatchRow & { round_state: RoundState | null, election_state: ElectionState }>(
    `select b.id, b.voter_group_id, b.round_kind, b.state, b.keys, r.state as round_state, e.state as election_state
       from ${BATCHES_WITH_KEYS} b
       join election e on e.id = b.election_id
       left join round r on r.election_id = b.election_id and r.kind = b.round_kind
      where b.id = $1 and b.election_id = $2`,
    [batchId, access.electionId],
  )
  if (!row) throw new Refusal(404, 'not_found')
  if (!mayReadKeys(access.role, row.round_state, row.election_state)) throw new Refusal(403, 'forbidden')
  const closed = keysOver(row.round_state, row.election_state)
  const { rows } = await db.query<{ key: string, used: boolean }>(
    `select c.key, coalesce(bool_or(e.consumed), false) as used
       from credential c left join credential_entitlement e on e.credential_id = c.id
      where c.batch_id = $1
      group by c.id, c.key
      order by c.key collate "C"`,
    [batchId],
  )
  return { batch: toSummary(row), keys: rows.map(({ key, used }) => ({ key, used: closed ? used : null })) }
}

export interface IssueInput {
  voterGroupId: string
  roundKind: RoundKind
  count: number
}

/**
 * Issues a batch of new keys for a voter group, inside changeElection: its
 * first batch for the round or a top-up, which leaves the group's other
 * batches as they are. A regular batch's keys are entitled to the contests
 * the group votes in; a runoff batch's to nothing until the runoff is
 * activated. Returns the batch with its keys, for printing.
 */
export async function issueBatch(client: pg.ClientBase, access: ElectionAccess, input: IssueInput): Promise<BatchKeys> {
  mayIssue(access, canIssueBatch(access.lifecycle, input.roundKind))
  if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > MAX_BATCH_KEYS) {
    throw new RangeError(`a batch holds 1 to ${MAX_BATCH_KEYS} keys, not ${input.count}`)
  }
  const { rows: [group] } = await client.query<{ id: string }>(
    'select id from voter_group where id = $1 and election_id = $2',
    [input.voterGroupId, access.electionId],
  )
  if (!group) throw new Refusal(404, 'not_found')
  const issued = await createBatch(client, access.electionId, group.id, input.roundKind, input.count)
  await appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'credential-batch.issued',
    metadata: { batch: issued.batch.id, group: group.id, round: input.roundKind, keys: input.count },
  })
  return issued
}

/**
 * Replaces a batch whose sheets were lost or must not be used, inside
 * changeElection: voids its keys and issues as many new ones for the same
 * group and round. Only until the batch's round opens; a void batch is
 * not replaced again. Returns the new batch with its keys.
 */
export async function replaceBatch(client: pg.ClientBase, access: ElectionAccess, batchId: string): Promise<BatchKeys> {
  const { rows: [row] } = await client.query<BatchRow>(
    `select b.id, b.voter_group_id, b.round_kind, b.state, b.keys
       from ${BATCHES_WITH_KEYS} b where b.id = $1 and b.election_id = $2`,
    [batchId, access.electionId],
  )
  if (!row) throw new Refusal(404, 'not_found')
  mayIssue(access, canRotateBatch(access.lifecycle, row.round_kind))
  if (row.state === 'void') throw new Refusal(409, 'batch_void')
  await client.query('update credential_batch set state = \'void\' where id = $1', [row.id])
  const replacement = await createBatch(client, access.electionId, row.voter_group_id, row.round_kind, row.keys)
  await appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'credential-batch.replaced',
    metadata: { batch: row.id, replacement: replacement.batch.id, group: row.voter_group_id, round: row.round_kind, keys: row.keys },
  })
  return replacement
}

/** Voids batches, inside the caller's transaction; the caller records why. */
export async function voidBatches(client: pg.ClientBase, batchIds: readonly string[]): Promise<void> {
  await client.query('update credential_batch set state = \'void\' where id = any($1::uuid[]) and state = \'issued\'', [batchIds])
}

function mayIssue(access: ElectionAccess, verdict: ReturnType<typeof canIssueBatch>): void {
  if (!isPermitted(access.role, 'issue-keys')) throw new Refusal(403, 'forbidden')
  if (!verdict.ok) throw new Refusal(409, verdict.refusal.replaceAll('-', '_'))
}

// A collision of two 95-bit keys is not expected in the lifetime of any
// installation; should one occur, the key that was already stored wins and
// another is drawn.
const MAX_ATTEMPTS = 3

async function createBatch(client: pg.ClientBase, electionId: string, groupId: string, roundKind: RoundKind, count: number): Promise<BatchKeys> {
  const { rows: [batch] } = await client.query<{ id: string }>(
    'insert into credential_batch (election_id, voter_group_id, round_kind) values ($1, $2, $3) returning id',
    [electionId, groupId, roundKind],
  )
  if (!batch) throw new Error('batch insert returned no row')
  const keys = await drawKeys(client, electionId, batch.id, count, MAX_ATTEMPTS)
  if (roundKind === 'regular') {
    await client.query(
      `insert into credential_entitlement (election_id, credential_id, round_contest_id)
       select c.election_id, c.id, rc.id
         from credential c
         join voter_group_contest m on m.voter_group_id = $2
         join round r on r.election_id = c.election_id and r.kind = 'regular'
         join round_contest rc on rc.round_id = r.id and rc.contest_id = m.contest_id
        where c.batch_id = $1`,
      [batch.id, groupId],
    )
  }
  return {
    batch: { id: batch.id, voterGroupId: groupId, roundKind, state: 'issued', keys: count },
    keys: keys.toSorted(order).map((key) => ({ key, used: null })),
  }
}

/** Draws `count` new keys for the batch and stores them, drawing again for any that was taken already. */
async function drawKeys(client: pg.ClientBase, electionId: string, batchId: string, count: number, attempts: number): Promise<string[]> {
  if (attempts === 0) throw new Error('could not draw unique keys')
  const drawn = Array.from({ length: count }, () => generateKey(crypto.getRandomValues(new Uint8Array(KEY_RANDOM_BYTES))))
  const stored = await storeKeys(client, electionId, batchId, drawn)
  if (stored.length === count) return stored
  return [...stored, ...await drawKeys(client, electionId, batchId, count - stored.length, attempts - 1)]
}

/** Stores the keys that are not taken yet and returns them. */
async function storeKeys(client: pg.ClientBase, electionId: string, batchId: string, keys: string[]): Promise<string[]> {
  try {
    const { rows } = await client.query<{ key: string }>(
      `insert into credential (election_id, batch_id, key) select $1::uuid, $2::uuid, unnest($3::text[])
       on conflict (key) do nothing returning key`,
      [electionId, batchId, keys],
    )
    return rows.map((row) => row.key)
  } catch (err) {
    // PostgreSQL's message or detail can quote the row, key included, and
    // the error handler logs what it is given: pass on the code alone.
    throw new Error(`storing keys failed with SQLSTATE ${sqlState(err) ?? 'unknown'}`)
  }
}

interface BatchRow {
  id: string
  voter_group_id: string
  round_kind: RoundKind
  state: BatchState
  keys: number
}

function toSummary(row: BatchRow): BatchSummary {
  return { id: row.id, voterGroupId: row.voter_group_id, roundKind: row.round_kind, state: row.state, keys: row.keys }
}

/** By UTF-16 code unit, the order of the C collation for keys and ids. */
function order(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
