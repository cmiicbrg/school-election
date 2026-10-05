// Opening, testing and closing a round, as the round routes run them
// inside changeElection: the lifecycle's say, the database's step, and
// the audit event. A test puts the regular round of a prepared election
// into a state that accepts ballots without having opened (migration
// 0011); ending it, through the owner's function, removes the test's
// ballots and sets every entitlement unused again. Opening is a direct
// update along the round's transition row, together with the election's
// step to active, the election first, as the triggers of migration 0009
// require; from a test, the opening ends the test first. Closing is the
// seal (0009), which makes the round's ballots unlinkable, followed in
// the same transaction by the count of every box over the sealed ballots
// and the snapshot of each result (lib/tally.ts): a close that cannot
// count rolls back, seal included, and the round stays open until it
// can. Turnout is the one figure about a round's votes that is read while
// it is open.

import type pg from 'pg'
import { canOpenRegular, transition, type Lifecycle, type OutcomeKind, type RoundKind, type RoundState } from '@school-election/election-core'
import { appendAudit } from './audit.ts'
import { Refusal, type ElectionAccess } from './election-access.ts'
import { contestOutcomes } from './outcome.ts'
import { isPermitted } from './permissions.ts'
import { SQLSTATE, sqlState } from './pg-errors.ts'
import type { BuildInfo } from '../config.ts'
import { tallyRound } from './tally.ts'

const roundId = async (client: pg.ClientBase, electionId: string, kind: RoundKind): Promise<string | undefined> =>
  (await client.query<{ id: string }>('select id from round where election_id = $1 and kind = $2', [electionId, kind])).rows[0]?.id

/** Starts a test of the prepared election: the regular round accepts ballots from now on, without having opened. */
export async function startTest(client: pg.ClientBase, access: ElectionAccess): Promise<void> {
  if (!isPermitted(access.role, 'run-rounds')) throw new Refusal(403, 'forbidden')
  const next = transition(access.lifecycle, 'start-test')
  if (!next.ok) throw new Refusal(409, next.refusal.replaceAll('-', '_'))
  // The election's row, as opening takes it: a candidate change in flight
  // holds it for share until it commits, and the next one waits for this.
  await client.query('select 1 from election where id = $1 for no key update', [access.electionId])
  const started = await client.query(`update round set state = 'testing' where election_id = $1 and kind = 'regular'`, [access.electionId])
  if (started.rowCount !== 1) throw new Refusal(409, 'not_prepared')
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'test.started', metadata: { round: 'regular' } })
}

export interface TestEnded {
  /** Ballots the test had staged, all removed. */
  ballots: number
  /** Keys that voted in the test, every entitlement of theirs unused again. */
  keys: number
}

/** Ends the test: nothing of it is kept, and the round is planned again. */
export async function endTest(client: pg.ClientBase, access: ElectionAccess): Promise<TestEnded> {
  if (!isPermitted(access.role, 'run-rounds')) throw new Refusal(403, 'forbidden')
  const next = transition(access.lifecycle, 'end-test')
  if (!next.ok) throw new Refusal(409, next.refusal.replaceAll('-', '_'))
  return endTestNow(client, access)
}

async function endTestNow(client: pg.ClientBase, access: ElectionAccess): Promise<TestEnded> {
  const round = await roundId(client, access.electionId, 'regular')
  if (round === undefined) throw new Refusal(409, 'not_prepared')
  let ended: TestEnded
  try {
    const { rows: [row] } = await client.query<{ ballots: number, keys: number }>('select ballots, keys from end_test($1)', [round])
    ended = { ballots: row?.ballots ?? 0, keys: row?.keys ?? 0 }
  } catch (err) {
    if (sqlState(err) === SQLSTATE.objectNotInPrerequisiteState) throw new Refusal(409, 'round_planned')
    throw err
  }
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'test.ended', metadata: { round: 'regular', ...ended } })
  return ended
}

/**
 * Opens the regular round: refused by the lifecycle (409 with its reason)
 * unless the election is prepared, by the role unless it may run rounds
 * (403). A running test is ended first, audited as such. The election
 * moves to active and the round to open in this transaction.
 */
export async function openRound(client: pg.ClientBase, access: ElectionAccess): Promise<void> {
  if (!isPermitted(access.role, 'run-rounds')) throw new Refusal(403, 'forbidden')
  const allowed = canOpenRegular(access.lifecycle)
  if (!allowed.ok) throw new Refusal(409, allowed.refusal.replaceAll('-', '_'))
  let lifecycle: Lifecycle = access.lifecycle
  if (lifecycle.regular === 'testing') {
    await endTestNow(client, access)
    lifecycle = { ...lifecycle, regular: 'planned' }
  }
  const next = transition(lifecycle, 'open-regular')
  if (!next.ok) throw new Refusal(409, next.refusal.replaceAll('-', '_'))
  await client.query(`update election set state = 'active' where id = $1`, [access.electionId])
  const opened = await client.query(`update round set state = 'open' where election_id = $1 and kind = 'regular'`, [access.electionId])
  if (opened.rowCount !== 1) throw new Refusal(409, 'not_prepared')
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'round.opened', metadata: { round: 'regular' } })
}

/**
 * Closes the election's round of that kind: refused by the lifecycle (409
 * with its reason) unless the round is open, by the role unless it may
 * run rounds (403), and by the seal (409 round_closed) when a concurrent
 * close got there first. Returns the round and the number of ballots sealed.
 */
export async function closeRound(client: pg.ClientBase, access: ElectionAccess, kind: RoundKind): Promise<{ roundId: string, ballots: number }> {
  if (!isPermitted(access.role, 'run-rounds')) throw new Refusal(403, 'forbidden')
  const next = transition(access.lifecycle, kind === 'regular' ? 'close-regular' : 'close-runoff')
  if (!next.ok) throw new Refusal(409, next.refusal.replaceAll('-', '_'))
  const { rows: [round] } = await client.query<{ id: string }>(
    'select id from round where election_id = $1 and kind = $2',
    [access.electionId, kind],
  )
  if (!round) throw new Refusal(409, 'no_runoff')
  let ballots: number
  try {
    const { rows: [sealed] } = await client.query<{ n: number }>('select seal_round($1) as n', [round.id])
    ballots = sealed?.n ?? 0
  } catch (err) {
    if (sqlState(err) === SQLSTATE.objectNotInPrerequisiteState) throw new Refusal(409, 'round_closed')
    throw err
  }
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'round.closed', metadata: { round: kind, ballots } })
  return { roundId: round.id, ballots }
}

export interface Closed {
  ballots: number
  contests: { contestId: string, outcome: OutcomeKind }[]
}

/**
 * Closes the round of that kind and counts it: the seal, then every box over
 * the sealed ballots, one snapshot and one audit event per contest, all in
 * this transaction. The audit event names the contest, the digest of what
 * was counted and the outcome's kind; the figures are in the snapshot. A
 * runoff box is counted over its pair, and its outcome is the first round's
 * with the runoff and the recorded lots (lib/tally.ts).
 */
export async function closeAndTally(client: pg.ClientBase, access: ElectionAccess, build: BuildInfo, kind: RoundKind = 'regular'): Promise<Closed> {
  const { roundId, ballots } = await closeRound(client, access, kind)
  const tallies = await tallyRound(client, access.electionId, roundId, build)
  for (const tally of tallies) {
    await appendAudit(client, access.electionId, {
      actor: access.actor,
      action: 'result.computed',
      metadata: { contest: tally.contestId, round: kind, inputSha256: tally.inputSha256, ballots: tally.ballots, outcome: tally.outcome.kind },
    })
  }
  return { ballots, contests: tallies.map((tally) => ({ contestId: tally.contestId, outcome: tally.outcome.kind })) }
}

export interface Activated {
  roundId: string
  /** The pair of every contest in the runoff, in ballot order. */
  contests: { contestId: string, candidates: [string, string] }[]
  /** Keys of the issued runoff batches entitled to vote. */
  keys: number
}

/**
 * Activates the runoff: refused by the lifecycle unless the regular round
 * has closed and no runoff exists (409 with its reason), by the role unless
 * it may run rounds (403), with 409 lot_required while a contest's runoff
 * entry waits for a lot, and with 409 no_runoff when no contest needs one.
 * The pairs come from the outcomes as they stand; the database creates the
 * round open with its boxes and the entitlements of every issued runoff
 * batch (activate_runoff, migration 0013). One event per pair, then the
 * activation with how many keys it entitled.
 */
export async function activateRunoff(client: pg.ClientBase, access: ElectionAccess): Promise<Activated> {
  if (!isPermitted(access.role, 'run-rounds')) throw new Refusal(403, 'forbidden')
  const next = transition(access.lifecycle, 'activate-runoff')
  if (!next.ok) throw new Refusal(409, next.refusal.replaceAll('-', '_'))
  const outcomes = await contestOutcomes(client, access.electionId)
  if (outcomes.some((entry) => entry.outcome.kind === 'lot-required' && entry.outcome.lots.some((lot) => lot.reason === 'runoff-entry'))) {
    throw new Refusal(409, 'lot_required')
  }
  const contests = outcomes.flatMap((entry) => entry.outcome.kind === 'runoff-required'
    ? [{ contestId: entry.contestId, candidates: [...entry.outcome.runoffCandidates] as [string, string] }]
    : [])
  if (contests.length === 0) throw new Refusal(409, 'no_runoff')
  let roundId: string
  try {
    const { rows: [row] } = await client.query<{ activate_runoff: string }>('select activate_runoff($1, $2::jsonb)', [access.electionId, JSON.stringify(contests)])
    roundId = row?.activate_runoff ?? ''
  } catch (err) {
    if (sqlState(err) === SQLSTATE.objectNotInPrerequisiteState) throw new Refusal(409, 'runoff_activated')
    throw err
  }
  const { rows: [entitled] } = await client.query<{ n: number }>(
    'select count(distinct e.credential_id)::int as n from credential_entitlement e join round_contest rc on rc.id = e.round_contest_id where rc.round_id = $1',
    [roundId],
  )
  const keys = entitled?.n ?? 0
  for (const contest of contests) {
    await appendAudit(client, access.electionId, {
      actor: access.actor,
      action: 'runoff.pair',
      metadata: { contest: contest.contestId, first: contest.candidates[0], second: contest.candidates[1] },
    })
  }
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'runoff.activated', metadata: { round: 'runoff', contests: contests.length, keys } })
  return { roundId, contests, keys }
}

export interface Turnout {
  /** The round's state, or null while the election has no such round. */
  round: RoundState | null
  /** Keys of issued batches of this round, and how many of them have used at least one entitlement. */
  keys: { issued: number, used: number }
  /** Per contest: entitlements of keys in issued batches, and how many are used up. */
  contests: { contestId: string, issued: number, used: number }[]
}

/** How many have voted, by contest and by key: counts only, never a candidate, never a key, in every state of the round. */
export async function readTurnout(client: pg.ClientBase, electionId: string, kind: RoundKind): Promise<Turnout> {
  const { rows: [round] } = await client.query<{ id: string, state: RoundState }>(
    'select id, state from round where election_id = $1 and kind = $2',
    [electionId, kind],
  )
  if (!round) return { round: null, keys: { issued: 0, used: 0 }, contests: [] }
  const contests = await client.query<{ contest_id: string, issued: number, used: number }>(
    `select rc.contest_id,
            count(e.credential_id) filter (where b.state = 'issued')::int as issued,
            count(e.credential_id) filter (where b.state = 'issued' and e.consumed)::int as used
       from round_contest rc
       left join credential_entitlement e on e.round_contest_id = rc.id
       left join credential c on c.id = e.credential_id
       left join credential_batch b on b.id = c.batch_id
      where rc.round_id = $1
      group by rc.contest_id`,
    [round.id],
  )
  // Issued keys count by their batch alone: a key whose entitlements a
  // draft edit removed is still a key on paper. Used ones by this round's
  // entitlements.
  const { rows: [keys] } = await client.query<{ issued: number, used: number }>(
    `select count(distinct c.id)::int as issued,
            count(distinct c.id) filter (where rc.id is not null and e.consumed)::int as used
       from credential c
       join credential_batch b on b.id = c.batch_id and b.state = 'issued' and b.round_kind = $2
       left join credential_entitlement e on e.credential_id = c.id
       left join round_contest rc on rc.id = e.round_contest_id and rc.round_id = $1
      where c.election_id = $3`,
    [round.id, kind, electionId],
  )
  return {
    round: round.state,
    keys: { issued: keys?.issued ?? 0, used: keys?.used ?? 0 },
    contests: contests.rows.map((row) => ({ contestId: row.contest_id, issued: row.issued, used: row.used })),
  }
}
