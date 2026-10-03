// Closing a round: the lifecycle's say, the seal (migration 0009), and the
// audit event, inside changeElection as the close route runs it. The seal
// is what closes the round and makes its ballots unlinkable; this only
// asks whether it may happen now, calls it, and records that it did, with
// the number of ballots: turnout, the one figure about a round's votes the
// log carries. Opening a round comes with its route.

import type pg from 'pg'
import { transition, type RoundKind } from '@school-election/election-core'
import { appendAudit } from './audit.ts'
import { Refusal, type ElectionAccess } from './election-access.ts'
import { isPermitted } from './permissions.ts'
import { SQLSTATE, sqlState } from './pg-errors.ts'

/**
 * Closes the election's round of that kind: refused by the lifecycle (409
 * with its reason) unless the round is open, by the role unless it may
 * run rounds (403), and by the seal (409 round_closed) when a concurrent
 * close got there first. Returns the number of ballots sealed.
 */
export async function closeRound(client: pg.ClientBase, access: ElectionAccess, kind: RoundKind): Promise<{ ballots: number }> {
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
  return { ballots }
}
