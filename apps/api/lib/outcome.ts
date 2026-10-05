// The outcome of every contest as it stands now: from the first-round
// snapshot, the runoff's snapshot once the runoff has closed, and the lots
// recorded so far, through election-core's resolve (a poll's through
// pollOutcome). Computed on every read and stored nowhere: the snapshots
// are the sealed truth, the lots the officials', and the outcome follows
// from them. At finalization the outcome as it stands is written once,
// per contest, with the versions that derived it (final_outcome), and
// from then on the declared outcome is the contest's: a final
// election shows what was declared, whatever a later version derives, and
// nothing of it is resolved again. A resolution the stored decisions make
// refuse is a hard error, like a missing snapshot: the database was
// changed by hand.

import type pg from 'pg'
import { pollOutcome, resolve, type FirstRoundResult, type LotDecision, type Outcome, type Resolution, type RulesetId, type RunoffResult } from '@school-election/election-core'
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
  /** As it stands: resolved now, or, once the election is final, as declared. */
  outcome: Outcome
  /** The declaration, once the election is final. */
  declared: FinalOutcome | null
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

interface LotRow {
  id: string
  contest_id: string
  lot_id: string
  candidates: string[]
  drawn: string[]
  reason: string
  actor_name: string
  recorded_at: Date
}

const lotOf = (row: LotRow): RecordedLot => ({ id: row.id, lotId: row.lot_id, candidates: row.candidates, drawn: row.drawn, reason: row.reason, actorName: row.actor_name, recordedAt: row.recorded_at.toISOString() })

/** The lots recorded for every contest of the election, on the first-round boxes, by contest, each in the order recorded. */
async function lotDecisionsByContest(client: pg.ClientBase, electionId: string): Promise<Map<string, RecordedLot[]>> {
  const { rows } = await client.query<LotRow>(
    `select d.id, rc.contest_id, d.lot_id, d.candidates, d.drawn, d.reason, d.actor_name, d.recorded_at
       from lot_decision d
       join round_contest rc on rc.id = d.round_contest_id
       join round r on r.id = rc.round_id
      where d.election_id = $1 and r.kind = 'regular'
      order by d.recorded_at, d.id`,
    [electionId],
  )
  const byContest = new Map<string, RecordedLot[]>()
  for (const row of rows) byContest.set(row.contest_id, [...(byContest.get(row.contest_id) ?? []), lotOf(row)])
  return byContest
}

/** The lots recorded for a contest, on its first-round box, in the order recorded. */
export async function lotDecisionsOf(client: pg.ClientBase, electionId: string, contestId: string): Promise<RecordedLot[]> {
  return (await lotDecisionsByContest(client, electionId)).get(contestId) ?? []
}

/** The decisions as resolve takes them. */
export const decisionsOf = (lots: readonly RecordedLot[]): LotDecision[] => lots.map((lot) => ({ lotId: lot.lotId, order: lot.drawn }))

/**
 * election-core's say on a contest from what is stored and the decisions
 * given: a poll's outcome as its one round has it (a poll has no lots, so
 * its resolution never refuses); a ranked contest's from its first round,
 * its runoff if that has closed, and the decisions, with resolve's typed
 * refusal of a decision that does not fit.
 */
export function resolutionOf(rulesetId: RulesetId, first: Snapshot, runoff: Snapshot | null, decisions: readonly LotDecision[]): Resolution {
  if (rulesetId === 'single-choice-v1') return { ok: true, outcome: pollOutcome(first.result as RunoffResult) }
  return resolve(first.result as FirstRoundResult, runoff === null ? undefined : runoff.result as RunoffResult, decisions)
}

/** The outcome of a contest from what is stored and the decisions recorded; stored decisions that resolve refuses are a hard error. */
export function outcomeOf(rulesetId: RulesetId, first: Snapshot, runoff: Snapshot | null, decisions: readonly LotDecision[]): Outcome {
  const resolution = resolutionOf(rulesetId, first, runoff, decisions)
  if (!resolution.ok) throw new OutcomeError(`contest ${first.contestId}: the recorded decisions were refused: ${resolution.error.kind} (${resolution.error.lotId})`)
  return resolution.outcome
}

/**
 * Every contest of the election, in the configuration's order, with its
 * first-round snapshot, its runoff snapshot where the runoff round has
 * closed, its recorded lots and its outcome as it stands: resolved now,
 * or the declared one once the election is final, which needs no
 * resolution by the version running today. Read once the regular round
 * has closed, when every contest has its snapshot: one without is a
 * database changed by hand, and an error.
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
  const lotsByContest = await lotDecisionsByContest(client, electionId)
  const declarations = await finalOutcomes(client, electionId)
  const outcomes: ContestOutcome[] = []
  for (const contest of configuration.contests) {
    const first = rows.find((row) => row.contest_id === contest.id && row.kind === 'regular')
    if (!first) throw new OutcomeError(`contest ${contest.id} has no first-round snapshot`)
    const runoffRow = rows.find((row) => row.contest_id === contest.id && row.kind === 'runoff')
    const lots = lotsByContest.get(contest.id) ?? []
    const firstSnapshot = snapshotOf(first)
    const runoff = runoffRow ? snapshotOf(runoffRow) : null
    const declared = declarations.get(contest.id) ?? null
    const outcome = declared ? declared.outcome : outcomeOf(contest.rulesetId, firstSnapshot, runoff, decisionsOf(lots))
    outcomes.push({ contestId: contest.id, rulesetId: contest.rulesetId, first: firstSnapshot, runoff, lots, outcome, declared })
  }
  return outcomes
}

/** A final outcome as declared at finalization, with the versions that derived it. */
export interface FinalOutcome {
  contestId: string
  outcome: Outcome
  tallyVersion: number
  appVersion: string
  gitSha: string
}

/** The declared outcome of every contest of a final election, by contest; empty before finalization. */
export async function finalOutcomes(client: pg.ClientBase, electionId: string): Promise<Map<string, FinalOutcome>> {
  const { rows } = await client.query<{ contest_id: string, outcome: Outcome, tally_version: number, app_version: string, git_sha: string }>(
    'select contest_id, outcome, tally_version, app_version, git_sha from final_outcome where election_id = $1', [electionId],
  )
  return new Map(rows.map((row) => [row.contest_id, { contestId: row.contest_id, outcome: row.outcome, tallyVersion: row.tally_version, appVersion: row.app_version, gitSha: row.git_sha }]))
}

export interface Finalization {
  reason: string
  actorName: string
  at: string
}

/** When, by whom and why the election was finalized, from its event; null before. */
export async function finalizationOf(client: pg.ClientBase, electionId: string): Promise<Finalization | null> {
  const { rows: [row] } = await client.query<{ at: Date, actor_name: string, reason: string }>(
    `select at, actor_name, metadata ->> 'reason' as reason from audit_event where election_id = $1 and action = 'election.finalized' order by seq desc limit 1`,
    [electionId],
  )
  return row ? { reason: row.reason, actorName: row.actor_name, at: row.at.toISOString() } : null
}

/** The outcome of one contest as it stands, or undefined for a contest that is not the election's. */
export async function contestOutcome(client: pg.ClientBase, electionId: string, contestId: string): Promise<ContestOutcome | undefined> {
  return (await contestOutcomes(client, electionId)).find((entry) => entry.contestId === contestId)
}
