// The outcome of every contest as it stands now: from the first-round
// snapshot, the runoff's snapshot once the runoff has closed, and the lots
// recorded so far, through election-core's resolve (a poll's through
// pollOutcome). Computed on every read and stored nowhere: the snapshots
// are the sealed truth, the lots the officials', and the outcome follows
// from them; the final positions are written once, at finalization. A
// resolution the stored decisions make refuse is a hard error, like a
// missing snapshot: the database was changed by hand.

import type pg from 'pg'
import { pollOutcome, resolve, type FirstRoundResult, type LotDecision, type Outcome, type RulesetId, type RunoffResult } from '@school-election/election-core'
import { readConfiguration } from './configuration.ts'

/** A stored snapshot, as the result routes return it. */
export interface Snapshot {
  contestId: string
  inputSha256: string
  tallyVersion: number
  appVersion: string
  gitSha: string
  result: unknown
  outcome: unknown
}

/** A lot as recorded: election-core's lot id, the tied set, the order drawn, the reason and who recorded it. */
export interface RecordedLot {
  id: string
  lotId: string
  candidates: string[]
  drawn: string[]
  reason: string
  actorName: string
  recordedAt: string
}

export interface ContestOutcome {
  contestId: string
  rulesetId: RulesetId
  first: Snapshot
  runoff: Snapshot | null
  lots: RecordedLot[]
  outcome: Outcome
}

/** What cannot be: a snapshot of the wrong kind, or stored decisions resolve refuses. Never a user error. */
export class OutcomeError extends Error {
  override name = 'OutcomeError'
}

interface SnapshotRow {
  contest_id: string
  kind: 'regular' | 'runoff'
  input_sha256: string
  tally_version: number
  app_version: string
  git_sha: string
  result: unknown
  outcome: unknown
}

const snapshotOf = (row: SnapshotRow): Snapshot => ({
  contestId: row.contest_id,
  inputSha256: row.input_sha256,
  tallyVersion: row.tally_version,
  appVersion: row.app_version,
  gitSha: row.git_sha,
  result: row.result,
  outcome: row.outcome,
})

/** The lots recorded for a contest, on its first-round box, in the order recorded. */
export async function lotDecisionsOf(client: pg.ClientBase, electionId: string, contestId: string): Promise<RecordedLot[]> {
  const { rows } = await client.query<{ id: string, lot_id: string, candidates: string[], drawn: string[], reason: string, actor_name: string, recorded_at: Date }>(
    `select d.id, d.lot_id, d.candidates, d.drawn, d.reason, d.actor_name, d.recorded_at
       from lot_decision d
       join round_contest rc on rc.id = d.round_contest_id
       join round r on r.id = rc.round_id
      where d.election_id = $1 and rc.contest_id = $2 and r.kind = 'regular'
      order by d.recorded_at, d.id`,
    [electionId, contestId],
  )
  return rows.map((row) => ({ id: row.id, lotId: row.lot_id, candidates: row.candidates, drawn: row.drawn, reason: row.reason, actorName: row.actor_name, recordedAt: row.recorded_at.toISOString() }))
}

/** The decisions as resolve takes them. */
export const decisionsOf = (lots: readonly RecordedLot[]): LotDecision[] => lots.map((lot) => ({ lotId: lot.lotId, order: lot.drawn }))

/**
 * The outcome of a contest from what is stored: a poll's as its one round
 * has it; a ranked contest's from its first round, its runoff if that has
 * closed, and the decisions.
 */
export function outcomeOf(rulesetId: RulesetId, first: Snapshot, runoff: Snapshot | null, decisions: readonly LotDecision[]): Outcome {
  if (rulesetId === 'single-choice-v1') return pollOutcome(first.result as RunoffResult)
  const resolution = resolve(first.result as FirstRoundResult, runoff === null ? undefined : runoff.result as RunoffResult, decisions)
  if (!resolution.ok) throw new OutcomeError(`contest ${first.contestId}: the recorded decisions were refused: ${resolution.error.kind} (${resolution.error.lotId})`)
  return resolution.outcome
}

/**
 * Every contest of the election that has a first-round snapshot, in the
 * configuration's order, with its runoff snapshot where the runoff round
 * has closed, its recorded lots and its outcome as it stands.
 */
export async function contestOutcomes(client: pg.ClientBase, electionId: string): Promise<ContestOutcome[]> {
  const { rows } = await client.query<SnapshotRow>(
    `select rc.contest_id, r.kind, s.input_sha256, s.tally_version, s.app_version, s.git_sha, s.result, s.outcome
       from result_snapshot s
       join round_contest rc on rc.id = s.round_contest_id
       join round r on r.id = rc.round_id
      where s.election_id = $1`,
    [electionId],
  )
  const configuration = await readConfiguration(client, electionId)
  const outcomes: ContestOutcome[] = []
  for (const contest of configuration.contests) {
    const first = rows.find((row) => row.contest_id === contest.id && row.kind === 'regular')
    if (!first) continue
    const runoffRow = rows.find((row) => row.contest_id === contest.id && row.kind === 'runoff')
    const lots = await lotDecisionsOf(client, electionId, contest.id)
    const firstSnapshot = snapshotOf(first)
    const runoff = runoffRow ? snapshotOf(runoffRow) : null
    outcomes.push({ contestId: contest.id, rulesetId: contest.rulesetId, first: firstSnapshot, runoff, lots, outcome: outcomeOf(contest.rulesetId, firstSnapshot, runoff, decisionsOf(lots)) })
  }
  return outcomes
}

/** The outcome of one contest as it stands, or undefined before its first round has a snapshot. */
export async function contestOutcome(client: pg.ClientBase, electionId: string, contestId: string): Promise<ContestOutcome | undefined> {
  return (await contestOutcomes(client, electionId)).find((entry) => entry.contestId === contestId)
}
