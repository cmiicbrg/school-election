// Casting a ballot: the one transaction that uses a key's entitlement up
// and stages the ballot (migration 0009), as the voter route runs it. It
// writes nothing else: no key, no session, no time, nothing that could be
// joined to the ballot later. The database keeps the rest: a ballot is
// staged only while its round accepts ballots and only one that fits its
// box, and the seal makes it unlinkable when the round closes.
//
// The ballot comes in validated by election-core for exactly the contest
// the caller names (isBallotFor), so what is staged is what the voter saw
// and confirmed, and the box has to belong to that contest. Nothing here
// logs, and nothing here adds a key or a ballot to an error.

import type pg from 'pg'
import { contestKey, isBallotFor, type CastBallot, type Contest } from '@school-election/election-core'
import { SQLSTATE, sqlState } from './pg-errors.ts'

export interface CastInput {
  credentialId: string
  /** The ballot box (round_contest) the ballot goes into. */
  roundContestId: string
  /** The contest the ballot was validated for, as the caller read it from the database. */
  contest: Contest
  ballot: CastBallot
}

/**
 * Why a ballot was not cast: the key has no entitlement for that box, it
 * used it up before, the box belongs to another contest than the ballot
 * was validated for, or the database refused the vote (the round no
 * longer accepts ballots, or the key's batch is void; or the vote waited
 * for the seal, which wrote the entitlement again, unused, under a
 * closed round).
 */
export type CastRefusal = 'not-entitled' | 'already-voted' | 'wrong-contest' | 'refused'

export type CastResult
  = | { cast: true }
    | { cast: false, reason: CastRefusal }

/**
 * Casts the ballot inside the caller's transaction: uses the entitlement up
 * and stages the ballot, or says why not. A refusal by the database leaves
 * the transaction usable (a savepoint), so the caller can still answer.
 * Never touches the key's row.
 */
export async function castBallot(client: pg.ClientBase, input: CastInput): Promise<CastResult> {
  if (!isBallotFor(input.ballot, contestKey(input.contest))) {
    throw new TypeError('the ballot was not validated for the contest it is cast in')
  }
  if (client.getTransactionStatus() !== 'T') {
    throw new Error('castBallot runs inside the transaction that answers the voter')
  }
  await client.query('savepoint cast_ballot')
  try {
    const used = await client.query<{ election_id: string }>(
      `update credential_entitlement e set consumed = true
         from round_contest rc
        where e.credential_id = $1 and e.round_contest_id = $2
          and rc.id = e.round_contest_id and rc.contest_id = $3
          and not e.consumed
        returning rc.election_id`,
      [input.credentialId, input.roundContestId, input.contest.id],
    )
    const electionId = used.rows[0]?.election_id
    // The reason is read while the savepoint stands, so a failure of that
    // read is recovered from like any other.
    const reason = electionId === undefined ? await whyNot(client, input) : undefined
    if (electionId !== undefined) {
      await client.query(
        'insert into ballot_box (election_id, round_contest_id, kind, ranking) values ($1, $2, $3, $4::uuid[])',
        [electionId, input.roundContestId, input.ballot.kind, [...input.ballot.ranking]],
      )
    }
    await client.query('release savepoint cast_ballot')
    return reason === undefined ? { cast: true } : { cast: false, reason }
  } catch (err) {
    // A rollback that fails itself leaves the transaction broken either
    // way; the error worth reporting is the first one.
    await client.query('rollback to savepoint cast_ballot').catch(() => undefined)
    if (sqlState(err) === SQLSTATE.objectNotInPrerequisiteState) return { cast: false, reason: 'refused' }
    throw err
  }
}

/**
 * One read, only once nothing was used up, to tell the voter why. An
 * entitlement that is there, for the right contest, and still unused was
 * written again by the seal while the vote waited for it: the update
 * found the old row gone, and the round is closed now.
 */
async function whyNot(client: pg.ClientBase, input: CastInput): Promise<CastRefusal> {
  const { rows: [row] } = await client.query<{ consumed: boolean, contest_id: string }>(
    `select e.consumed, rc.contest_id
       from credential_entitlement e join round_contest rc on rc.id = e.round_contest_id
      where e.credential_id = $1 and e.round_contest_id = $2`,
    [input.credentialId, input.roundContestId],
  )
  if (!row) return 'not-entitled'
  if (row.contest_id !== input.contest.id) return 'wrong-contest'
  return row.consumed ? 'already-voted' : 'refused'
}
