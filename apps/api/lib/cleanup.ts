// The clean-up after an election, the first step of finalization
// (lib/finalize.ts): once every round is sealed, the data directory still
// holds what the seals removed, as dead rows (the staged ballots the seal
// deleted, the entitlement versions the votes and the seal replaced) and
// as the write-ahead log of the vote transactions, and a copy of it could
// still pair ballots with keys. This rewrites the two tables without their
// dead rows and flushes the write-ahead log until no segment written
// before the rewrite remains on disk, and proves it (docs/privacy-model.md).
//
// Outside any transaction, on the pool's plain query: VACUUM cannot run
// inside one. The two elevated steps are the owner's functions (migration
// 0014): cleanup_blockers counts what still holds a snapshot older than
// the election's seals, which would make VACUUM keep the dead rows; and
// flush_wal switches and checkpoints, and says whether the old segments
// are gone. The rewrite itself needs the role's own MAINTAIN on the two
// tables (lib/runtime-privileges.ts). Idempotent and harmless on any
// election at any time; a request's cost is a few seconds at school scale.

import { setTimeout as sleep } from 'node:timers/promises'
import type { RoundKind } from '@school-election/election-core'
import type { Database } from './db.ts'
import { Refusal } from './election-access.ts'
import { SQLSTATE, sqlState } from './pg-errors.ts'

/** The two tables with dead rows of the votes; `ballot` has none, the seal only inserts there. */
const REWRITTEN = ['ballot_box', 'credential_entitlement'] as const

/** How long a request waits for an older snapshot to end before it refuses; and how often it looks. */
export const BLOCKED_WAIT_MS = 10_000
export const BLOCKED_POLL_MS = 250

/** The phase of every round of the election at the clean-up, so finalization can tell whether a round changed in between. */
export type RoundPhases = Readonly<Partial<Record<RoundKind, string>>>

export interface CleanUpOptions {
  /** How long to wait for older snapshots to end; the tests shorten it. */
  waitMs?: number
  pollMs?: number
}

/**
 * Cleans the election up and returns the phases its rounds were in: refused
 * with `cleanup_blocked` (409) while a session, a prepared transaction or a
 * replication slot holds a snapshot older than the seals past the wait, or
 * while a lock behind a running dump outlasts the statement timeout, both
 * to be tried again; with `wal_retained` (409) when the write-ahead log
 * written before the rewrite is still on disk afterwards, which the
 * settings the server requires at startup forbid, so the operator looks at
 * the server.
 */
export async function cleanUp(db: Pick<Database, 'query'>, electionId: string, { waitMs = BLOCKED_WAIT_MS, pollMs = BLOCKED_POLL_MS }: CleanUpOptions = {}): Promise<RoundPhases> {
  const phases = await roundPhases(db, electionId)
  await waitForSnapshots(db, electionId, waitMs, pollMs)
  for (const table of REWRITTEN) {
    try {
      // Names from the fixed list above, never from input.
      await db.query(`vacuum full ${table}`)
    } catch (err) {
      if (sqlState(err) === SQLSTATE.queryCanceled) throw new Refusal(409, 'cleanup_blocked')
      throw err
    }
  }
  const { rows: [position] } = await db.query<{ lsn: string }>('select pg_current_wal_lsn()::text as lsn')
  const { rows: [flushed] } = await db.query<{ cleared: boolean }>('select flush_wal($1::pg_lsn) as cleared', [position?.lsn ?? '0/0'])
  if (flushed?.cleared !== true) throw new Refusal(409, 'wal_retained')
  return phases
}

/** The phase id of every round of the election, by kind. */
export async function roundPhases(db: Pick<Database, 'query'>, electionId: string): Promise<RoundPhases> {
  const { rows } = await db.query<{ kind: RoundKind, phase: string }>('select kind, phase from round where election_id = $1', [electionId])
  return Object.fromEntries(rows.map((row) => [row.kind, row.phase]))
}

/** How many sessions, prepared transactions and slots still hold a snapshot older than the election's seals. */
export async function cleanupBlockers(db: Pick<Database, 'query'>, electionId: string): Promise<number> {
  const { rows: [row] } = await db.query<{ blockers: number }>('select cleanup_blockers($1) as blockers', [electionId])
  return row?.blockers ?? 0
}

async function waitForSnapshots(db: Pick<Database, 'query'>, electionId: string, waitMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  for (;;) {
    if (await cleanupBlockers(db, electionId) === 0) return
    if (Date.now() >= deadline) throw new Refusal(409, 'cleanup_blocked')
    await sleep(pollMs)
  }
}
