// Recording a lot the officials drew, inside changeElection: for a lot the
// contest's outcome requires, by someone who runs rounds, while no round is
// open; the order drawn is exactly the lot's tied set, as election-core's
// resolve checks before the row is written; the event names the actor,
// the lot, the set, the order and the reason. The software never draws:
// it applies what was recorded, every time the outcome is read.

import type pg from 'pg'
import { canEnterLot, type Outcome } from '@school-election/election-core'
import { appendAudit } from './audit.ts'
import { Refusal, type ElectionAccess } from './election-access.ts'
import { contestOutcome, decisionsOf, outcomeOf, type ContestOutcome } from './outcome.ts'
import { isPermitted } from './permissions.ts'

export interface LotInput {
  contestId: string
  lotId: string
  /** The tied set in the order drawn. */
  order: string[]
  reason: string
}

export interface LotRecorded {
  contestId: string
  outcome: Outcome
}

/** Whether the outcome needs this lot now. */
function requires(entry: ContestOutcome, lotId: string): boolean {
  return entry.outcome.kind === 'lot-required' && entry.outcome.lots.some((lot) => lot.id === lotId)
}

export async function recordLot(client: pg.ClientBase, access: ElectionAccess, given: LotInput): Promise<LotRecorded> {
  if (!isPermitted(access.role, 'run-rounds')) throw new Refusal(403, 'forbidden')
  const allowed = canEnterLot(access.lifecycle)
  if (!allowed.ok) throw new Refusal(409, allowed.refusal.replaceAll('-', '_'))
  // Ids as the database and election-core hold them: the schema takes a UUID in any case.
  const input: LotInput = { ...given, contestId: given.contestId.toLowerCase(), order: given.order.map((id) => id.toLowerCase()) }
  const entry = await contestOutcome(client, access.electionId, input.contestId)
  if (!entry) throw new Refusal(404, 'not_found')
  if (entry.lots.some((lot) => lot.lotId === input.lotId)) throw new Refusal(409, 'duplicate_lot')
  if (!requires(entry, input.lotId)) throw new Refusal(409, 'lot_not_required')
  const lot = entry.outcome.kind === 'lot-required' ? entry.outcome.lots.find((candidate) => candidate.id === input.lotId) : undefined
  if (!lot) throw new Refusal(409, 'lot_not_required')
  // The decision as resolve will apply it: refused here before anything is written.
  let outcome: Outcome
  try {
    outcome = outcomeOf(entry.rulesetId, entry.first, entry.runoff, [...decisionsOf(entry.lots), { lotId: input.lotId, order: input.order }])
  } catch {
    throw new Refusal(400, 'not_the_tied_set')
  }
  const { rows: [box] } = await client.query<{ id: string }>(
    `select rc.id from round_contest rc join round r on r.id = rc.round_id where rc.election_id = $1 and rc.contest_id = $2 and r.kind = 'regular'`,
    [access.electionId, input.contestId],
  )
  if (!box) throw new Refusal(404, 'not_found')
  await client.query(
    `insert into lot_decision (election_id, round_contest_id, lot_id, candidates, drawn, reason, actor_tid, actor_oid, actor_name)
     values ($1, $2, $3, $4::uuid[], $5::uuid[], $6, $7, $8, $9)`,
    [access.electionId, box.id, input.lotId, [...lot.candidates], input.order, input.reason, access.actor.tid, access.actor.oid, access.actor.name],
  )
  await appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'lot.recorded',
    metadata: { contest: input.contestId, lotId: input.lotId, candidates: lot.candidates.join(','), order: input.order.join(','), reason: input.reason },
  })
  return { contestId: input.contestId, outcome }
}
