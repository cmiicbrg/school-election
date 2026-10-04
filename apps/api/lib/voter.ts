// What a voter's requests read and write: the key's redemption, the
// contests the key may vote in, a ballot cast, a candidate's picture. All
// of it is keyed by the credential's id from the session, never by the
// key, and all of it runs as the runtime role, which cannot read a staged
// ballot or restore an entitlement.

import type pg from 'pg'
import { activeSlots, RULESETS, type RoundState, type RulesetId } from '@school-election/election-core'
import type { Database } from './db.ts'
import { compareCandidates, compareLabels } from './names.ts'

/** The pool or a client in a transaction: both answer a query. */
export type Queryable = Pick<Database, 'query'>

/** The states of a round in which a key votes: the election, or the teacher's test. */
export type VotingState = 'open' | 'testing'

export interface RedeemedKey {
  credentialId: string
  electionId: string
  /** The key's round, or null while the batch's round does not exist yet (runoff keys before activation). */
  roundId: string | null
  roundState: RoundState | null
  /** The round's phase (migration 0012): a fresh id each time its state changes, so a session knows when its phase is over. */
  phase: string | null
  acceptsBallots: boolean
}

/** The key as stored, of an issued batch, with its round as it is now; undefined for an unknown key or one of a void batch, alike. */
export async function lookUpKey(db: Queryable, key: string): Promise<RedeemedKey | undefined> {
  const { rows: [row] } = await db.query<{ id: string, election_id: string, round_id: string | null, state: RoundState | null, phase: string | null, accepts: boolean | null }>(
    `select c.id, c.election_id, r.id as round_id, r.state, r.phase, rs.accepts_ballots as accepts
       from credential c
       join credential_batch b on b.id = c.batch_id and b.state = 'issued'
       left join round r on r.election_id = c.election_id and r.kind = b.round_kind
       left join round_state rs on rs.state = r.state
      where c.key = $1`,
    [key],
  )
  if (!row) return undefined
  return { credentialId: row.id, electionId: row.election_id, roundId: row.round_id, roundState: row.state, phase: row.phase, acceptsBallots: row.accepts === true }
}

export interface VoterCandidate {
  id: string
  surname: string
  givenName: string
  picture: string | null
}

export interface VoterContest {
  id: string
  roundContestId: string
  title: string
  rulesetId: RulesetId
  activeSlots: number
  done: boolean
  candidates: VoterCandidate[]
}

export interface VoterElection {
  title: string
  round: VotingState
  contests: VoterContest[]
  remaining: number
}

/**
 * The round's state and phase as they are now, or undefined once the round is gone (its election
 * deleted after a test). With `lock`, the row is held for share until the transaction ends: a change
 * of state in flight commits first and is seen, or waits for this transaction.
 */
export async function roundNow(db: Queryable, roundId: string, lock = false): Promise<{ state: RoundState, phase: string } | undefined> {
  const { rows: [row] } = await db.query<{ state: RoundState, phase: string }>(`select state, phase from round where id = $1${lock ? ' for share' : ''}`, [roundId])
  return row
}

/** The election's title and the contests the key is entitled to in its round, in the configuration's order with candidates in ballot order, each with whether the key has voted there. */
export async function voterElection(db: Queryable, credentialId: string, roundId: string, round: VotingState): Promise<VoterElection> {
  const { rows: [election] } = await db.query<{ title: string }>(
    'select e.title from round r join election e on e.id = r.election_id where r.id = $1',
    [roundId],
  )
  if (!election) throw new Error('the session names a round that is gone')
  const { rows: entitled } = await db.query<{ contest_id: string, box_id: string, title: string, ruleset_id: RulesetId, consumed: boolean }>(
    `select c.id as contest_id, rc.id as box_id, c.title, c.ruleset_id, e.consumed
       from credential_entitlement e
       join round_contest rc on rc.id = e.round_contest_id
       join contest c on c.id = rc.contest_id
      where e.credential_id = $1 and rc.round_id = $2
      order by c.id`,
    [credentialId, roundId],
  )
  // The order of the configuration screens: numbers as numbers, ids for a tie (the sort is stable).
  entitled.sort((a, b) => compareLabels(a.title, b.title))
  const { rows: candidates } = await db.query<{ id: string, contest_id: string, surname: string, given_name: string, picture_sha256: string | null }>(
    'select id, contest_id, surname, given_name, picture_sha256 from candidate where contest_id = any($1)',
    [entitled.map((row) => row.contest_id)],
  )
  const contests = entitled.map((row) => {
    const listed = candidates
      .filter((candidate) => candidate.contest_id === row.contest_id)
      .map((candidate) => ({ id: candidate.id, surname: candidate.surname, givenName: candidate.given_name, picture: candidate.picture_sha256 }))
      .sort(compareCandidates)
    return {
      id: row.contest_id,
      roundContestId: row.box_id,
      title: row.title,
      rulesetId: row.ruleset_id,
      activeSlots: listed.length === 0 ? 0 : activeSlots(RULESETS[row.ruleset_id], listed.length).length,
      done: row.consumed,
      candidates: listed,
    }
  })
  return {
    title: election.title,
    round,
    contests,
    remaining: contests.filter((contest) => !contest.done).length,
  }
}

/** The contest a ballot box belongs to, if the key is entitled to that box in its round. */
export async function entitledBox(client: pg.ClientBase, credentialId: string, roundId: string, roundContestId: string): Promise<{ contestId: string, electionId: string } | undefined> {
  const { rows: [row] } = await client.query<{ contest_id: string, election_id: string }>(
    `select rc.contest_id, rc.election_id
       from round_contest rc
       join credential_entitlement e on e.round_contest_id = rc.id and e.credential_id = $1
      where rc.id = $2 and rc.round_id = $3`,
    [credentialId, roundContestId, roundId],
  )
  return row ? { contestId: row.contest_id, electionId: row.election_id } : undefined
}

/** How many of the key's entitlements in its round are still unused. */
export async function remainingBoxes(client: Queryable, credentialId: string, roundId: string): Promise<number> {
  const { rows: [row] } = await client.query<{ n: number }>(
    `select count(*)::int as n from credential_entitlement e join round_contest rc on rc.id = e.round_contest_id
      where e.credential_id = $1 and rc.round_id = $2 and not e.consumed`,
    [credentialId, roundId],
  )
  return row?.n ?? 0
}

/** The picture of a candidate the key may vote for, by its content hash; null for a revalidation that only needs to know it is there. */
export async function voterPicture(db: Queryable, credentialId: string, roundId: string, sha256: string, bytes: boolean): Promise<{ picture: Buffer | null } | undefined> {
  const { rows: [row] } = await db.query<{ picture: Buffer | null }>(
    `select ${bytes ? 'c.picture' : 'null as picture'}
       from candidate c
       join round_contest rc on rc.contest_id = c.contest_id and rc.round_id = $2
       join credential_entitlement e on e.round_contest_id = rc.id and e.credential_id = $1
      where c.picture_sha256 = $3
      limit 1`,
    [credentialId, roundId, sha256],
  )
  return row
}
