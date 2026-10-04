// The count of a round's contests over its sealed ballots, in the
// transaction that seals the round (lib/rounds.ts): election-core's result
// per contest, the outcome as it stands without lots, and a snapshot of
// both with the digest of what the count saw and the versions that
// computed it (migration 0010). The count is reproducible by construction:
// the same configuration and the same ballots, in any order, give the
// same digest and the same result, and a later run can compare.
//
// The ballots come back from the database exactly as the seal wrote them
// and go through election-core's validation again before they count: a
// stored ballot that no longer validates is a programming error, and the
// close fails rather than counting it or skipping it.

import { createHash } from 'node:crypto'
import type pg from 'pg'
import {
  firstRoundResult,
  pollOutcome,
  resolve,
  runoffResult,
  TALLY_VERSION,
  validateBallot,
  type BallotKind,
  type CastBallot,
  type Contest,
  type FirstRoundResult,
  type Outcome,
  type RunoffResult,
} from '@school-election/election-core'
import type { BuildInfo } from '../config.ts'
import { canonicalJson } from './canonical-json.ts'
import { readConfiguration } from './configuration.ts'
import { Refusal } from './election-access.ts'
import { inOrder } from './in-order.ts'
import { decisionsOf, lotDecisionsOf } from './outcome.ts'
import { compareCandidates } from './names.ts'
import { SQLSTATE, sqlState } from './pg-errors.ts'

export interface ContestTally {
  contestId: string
  ballots: number
  inputSha256: string
  /** The first round of a ranked contest, or the one round of a single-choice poll. */
  result: FirstRoundResult | RunoffResult
  outcome: Outcome
}

/** A stored snapshot, as the result route returns it. */
export interface StoredResult {
  contestId: string
  inputSha256: string
  tallyVersion: number
  appVersion: string
  gitSha: string
  result: unknown
  outcome: unknown
}

/** The count met what cannot be: a ballot the seal wrote that election-core refuses, or a box without its contest. Never a user error. */
export class TallyError extends Error {
  override name = 'TallyError'
}

interface BallotRow {
  kind: BallotKind
  ranking: string[]
}

/**
 * The ballots of one box as election-core accepts them, from the rows the
 * seal wrote: a ranking as stored, "Nein" as such, and an invalid vote as
 * the confirmed incomplete ranking it was (its content is not kept).
 */
export function ballotsOf(contest: Contest, rows: readonly BallotRow[]): CastBallot[] {
  return rows.map((row, index) => {
    const input = row.kind === 'invalid'
      ? { kind: 'ranking', ranking: [], confirmInvalid: true }
      : { kind: row.kind, ranking: row.ranking }
    const checked = validateBallot(contest, input)
    if (!checked.ok) throw new TallyError(`ballot ${index} of contest ${contest.id} does not validate: ${checked.error.kind}`)
    return checked.ballot
  })
}

/**
 * What the count saw, as canonical JSON: the tally version, the contest
 * (id, ruleset, candidates in ballot order) and the ballots, the ballots
 * in an order that depends on their content alone (the kind, then the
 * ranking as positions on the ballot), so the text is the same however
 * the rows came back.
 */
export function tallyInput(contest: Contest, ballots: readonly CastBallot[]): string {
  const position = new Map(contest.candidateIds.map((id, index) => [id, index]))
  const keyOf = (ballot: CastBallot) => `${ballot.kind}:${ballot.ranking.map((id) => position.get(id) ?? -1).join(',')}`
  const sorted = ballots
    .map((ballot) => ({ ballot, key: keyOf(ballot) }))
    .sort((a, b) => compareKeys(a.key, b.key))
    .map(({ ballot }) => ({ kind: ballot.kind, ranking: [...ballot.ranking] }))
  const input = {
    tallyVersion: TALLY_VERSION,
    contest: { id: contest.id, rulesetId: contest.rulesetId, candidateIds: [...contest.candidateIds] },
    ballots: sorted,
  }
  return canonicalJson(input)
}

/** Code unit order, the same on every machine; never the locale's. */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** The SHA-256 of the count's input, in lower-case hex. */
export function inputDigest(contest: Contest, ballots: readonly CastBallot[]): string {
  return createHash('sha256').update(tallyInput(contest, ballots), 'utf8').digest('hex')
}

/** A ballot box with its contest as election-core sees it: the pair as a single-choice contest for a runoff box, the contest as configured otherwise. */
export interface BoxContest {
  boxId: string
  electionId: string
  roundId: string
  contest: Contest
  /** The first-round contest a runoff box decides, or null for a first-round box. */
  runoffOf: string | null
}

/**
 * The contest of a ballot box, as election-core sees it: for a runoff box
 * the pair, in ballot order, as a single-choice contest naming the first
 * round it decides; for any other box the contest as configured, its
 * candidates in ballot order. Undefined for a box that is not there.
 */
export async function contestOfBox(client: pg.ClientBase, boxId: string): Promise<BoxContest | undefined> {
  const { rows: [box] } = await client.query<{ election_id: string, round_id: string, contest_id: string, ruleset_id: Contest['rulesetId'], runoff_pair: string[] | null }>(
    `select rc.election_id, rc.round_id, rc.contest_id, c.ruleset_id, rc.runoff_pair
       from round_contest rc join contest c on c.id = rc.contest_id where rc.id = $1`,
    [boxId],
  )
  if (!box) return undefined
  const { rows: candidates } = await client.query<{ id: string, surname: string, given_name: string }>(
    'select id, surname, given_name from candidate where contest_id = $1',
    [box.contest_id],
  )
  const listed = candidates
    .filter((candidate) => box.runoff_pair === null || box.runoff_pair.includes(candidate.id))
    .map((candidate) => ({ id: candidate.id, surname: candidate.surname, givenName: candidate.given_name }))
    .sort(compareCandidates)
  const contest: Contest = box.runoff_pair === null
    ? { id: box.contest_id, rulesetId: box.ruleset_id, candidateIds: listed.map((candidate) => candidate.id) }
    : { id: box.contest_id, rulesetId: 'single-choice-v1', candidateIds: listed.map((candidate) => candidate.id) }
  return { boxId, electionId: box.election_id, roundId: box.round_id, contest, runoffOf: box.runoff_pair === null ? null : box.contest_id }
}

/**
 * The result of a runoff box over its sealed ballots, and the outcome as it
 * stands with it: the first round's stored result, this runoff and the
 * decisions recorded so far, through resolve.
 */
export function tallyRunoff(contest: Contest, ballots: readonly CastBallot[], first: FirstRoundResult, decisions: readonly { lotId: string, order: readonly string[] }[]): ContestTally {
  const inputSha256 = inputDigest(contest, ballots)
  const result = runoffResult(contest, ballots, first.contestId)
  const resolution = resolve(first, result, decisions)
  if (!resolution.ok) throw new TallyError(`resolving contest ${contest.id} with its runoff was refused: ${resolution.error.kind} (${resolution.error.lotId})`)
  return { contestId: contest.id, ballots: ballots.length, inputSha256, result, outcome: resolution.outcome }
}

/** The result of one contest's round and its outcome without lots, with the digest of the input: a ranked contest's first round, or a poll's one round. */
export function tallyContest(contest: Contest, ballots: readonly CastBallot[]): ContestTally {
  const inputSha256 = inputDigest(contest, ballots)
  if (contest.rulesetId === 'single-choice-v1') {
    const poll = runoffResult(contest, ballots, null)
    return { contestId: contest.id, ballots: ballots.length, inputSha256, result: poll, outcome: pollOutcome(poll) }
  }
  const result = firstRoundResult(contest, ballots)
  const resolution = resolve(result, undefined, [])
  // Without decisions nothing can be refused; the type says so anyway.
  if (!resolution.ok) throw new TallyError(`resolving contest ${contest.id} without decisions was refused: ${resolution.error.kind}`)
  return { contestId: contest.id, ballots: ballots.length, inputSha256, result, outcome: resolution.outcome }
}

/** The contests of an election as election-core sees them, in the configuration's order. */
async function contestsOf(client: pg.ClientBase, electionId: string): Promise<Contest[]> {
  const configuration = await readConfiguration(client, electionId)
  return configuration.contests.map((contest) => ({
    id: contest.id,
    rulesetId: contest.rulesetId,
    candidateIds: contest.candidates.map((candidate) => candidate.id),
  }))
}

/**
 * Counts every box of the round over its sealed ballots and writes one
 * snapshot per box, in the configuration's order of the contests. Runs in
 * the transaction that sealed the round, holding the election's lock, so
 * what it reads is what the seal wrote and nothing else.
 */
export async function tallyRound(client: pg.ClientBase, electionId: string, roundId: string, build: BuildInfo): Promise<ContestTally[]> {
  const boxes = await client.query<{ id: string, contest_id: string }>(
    'select id, contest_id from round_contest where round_id = $1',
    [roundId],
  )
  const boxOf = new Map(boxes.rows.map((box) => [box.contest_id, box.id]))
  const contests = (await contestsOf(client, electionId)).filter((contest) => boxOf.has(contest.id))
  if (contests.length !== boxOf.size) throw new TallyError('a ballot box of the round belongs to no contest of the election')
  const tallies: ContestTally[] = []
  await inOrder(contests, async (configured) => {
    const boxId = boxOf.get(configured.id) ?? ''
    const box = await contestOfBox(client, boxId)
    if (!box) throw new TallyError(`ballot box ${boxId} is gone`)
    const { contest } = box
    const rows = await client.query<BallotRow>('select kind, ranking from ballot where round_contest_id = $1 order by id', [boxId])
    const ballots = ballotsOf(contest, rows.rows)
    const tally = box.runoffOf === null
      ? tallyContest(contest, ballots)
      : tallyRunoff(contest, ballots, await firstRoundOf(client, electionId, box.runoffOf), decisionsOf(await lotDecisionsOf(client, electionId, box.runoffOf)))
    await client.query(
      `insert into result_snapshot (election_id, round_contest_id, input_sha256, tally_version, app_version, git_sha, result, outcome)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [electionId, boxId, tally.inputSha256, TALLY_VERSION, build.version, build.gitSha, JSON.stringify(tally.result), JSON.stringify(tally.outcome)],
    )
    tallies.push(tally)
  })
  return tallies
}

/** The stored first-round result of a ranked contest, which its runoff decides. */
async function firstRoundOf(client: pg.ClientBase, electionId: string, contestId: string): Promise<FirstRoundResult> {
  const { rows: [row] } = await client.query<{ result: FirstRoundResult | RunoffResult }>(
    `select s.result from result_snapshot s
       join round_contest rc on rc.id = s.round_contest_id
       join round r on r.id = rc.round_id
      where s.election_id = $1 and rc.contest_id = $2 and r.kind = 'regular'`,
    [electionId, contestId],
  )
  if (!row) throw new TallyError(`contest ${contestId} has no first-round snapshot for its runoff`)
  if ('runoffOf' in row.result) throw new TallyError(`contest ${contestId} is a poll, which has no runoff`)
  return row.result
}

/**
 * The count of a test, from the ballots the test has staged so far, in the
 * configuration's order of the contests: computed on every read, stored
 * nowhere. The database hands the ballots out only while the round is in
 * test mode; a test that ended between the route's guard and this read
 * is refused as the guard would have refused it (409 round_planned).
 */
export async function tallyTest(client: pg.ClientBase, electionId: string, roundId: string, build: BuildInfo): Promise<StoredResult[]> {
  const boxes = await client.query<{ id: string, contest_id: string }>('select id, contest_id from round_contest where round_id = $1', [roundId])
  const boxOf = new Map(boxes.rows.map((box) => [box.contest_id, box.id]))
  let staged: pg.QueryResult<BallotRow & { round_contest_id: string }>
  try {
    staged = await client.query<BallotRow & { round_contest_id: string }>('select round_contest_id, kind, ranking from test_ballots($1)', [roundId])
  } catch (err) {
    if (sqlState(err) === SQLSTATE.objectNotInPrerequisiteState) throw new Refusal(409, 'round_planned')
    throw err
  }
  const results: StoredResult[] = []
  for (const contest of await contestsOf(client, electionId)) {
    const boxId = boxOf.get(contest.id)
    if (boxId === undefined) continue
    const rows = staged.rows.filter((row) => row.round_contest_id === boxId)
    const tally = tallyContest(contest, ballotsOf(contest, rows))
    results.push({
      contestId: contest.id,
      inputSha256: tally.inputSha256,
      tallyVersion: TALLY_VERSION,
      appVersion: build.version,
      gitSha: build.gitSha,
      result: tally.result,
      outcome: tally.outcome,
    })
  }
  return results
}

/**
 * The snapshots of a round, in the configuration's order of the contests.
 * A closed round has one per ballot box, written with the seal; a round
 * without them is not a result but a database that was changed by hand,
 * and an error rather than an empty list.
 */
export async function readResults(client: pg.ClientBase, electionId: string, roundId: string): Promise<StoredResult[]> {
  const stored = await client.query<{ contest_id: string, input_sha256: string, tally_version: number, app_version: string, git_sha: string, result: unknown, outcome: unknown }>(
    `select rc.contest_id, s.input_sha256, s.tally_version, s.app_version, s.git_sha, s.result, s.outcome
       from result_snapshot s join round_contest rc on rc.id = s.round_contest_id
      where rc.round_id = $1`,
    [roundId],
  )
  const { rows: [boxes] } = await client.query<{ n: number }>('select count(*)::int as n from round_contest where round_id = $1', [roundId])
  if (stored.rows.length !== (boxes?.n ?? 0)) throw new TallyError(`round ${roundId} has ${stored.rows.length} snapshots for ${boxes?.n ?? 0} ballot boxes`)
  const byContest = new Map(stored.rows.map((row) => [row.contest_id, row]))
  const results: StoredResult[] = []
  for (const contest of await contestsOf(client, electionId)) {
    const row = byContest.get(contest.id)
    if (!row) continue
    results.push({
      contestId: contest.id,
      inputSha256: row.input_sha256,
      tallyVersion: row.tally_version,
      appVersion: row.app_version,
      gitSha: row.git_sha,
      result: row.result,
      outcome: row.outcome,
    })
  }
  return results
}
