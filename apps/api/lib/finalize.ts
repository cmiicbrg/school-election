// Finalizing an election, inside changeElection, after the clean-up
// (lib/cleanup.ts) ran outside it: by the owner, with a reason, once the
// regular round has closed and while no round is open. The outcome of
// every contest as it stands is written once (final_outcome, migration
// 0014) with the versions that derived it, whatever its kind: a botched
// election ends as it stands, and the reason says why; the issued runoff
// batches of an election that held no runoff are voided, so no key of the
// election can vote any more; the election moves to final, after which
// the triggers refuse every change; and the event names the reason and
// how many contests were resolved. The rounds must be in the phases the
// clean-up saw, or nothing is declared.

import type pg from 'pg'
import { TALLY_VERSION, transition, type OutcomeKind, type RoundKind } from '@school-election/election-core'
import type { BuildInfo } from '../config.ts'
import { appendAudit } from './audit.ts'
import { BATCHES_WITH_KEYS } from './batch-keys.ts'
import type { RoundPhases } from './cleanup.ts'
import { voidBatches } from './credentials.ts'
import { Refusal, type ElectionAccess } from './election-access.ts'
import { inOrder } from './in-order.ts'
import { contestOutcomes } from './outcome.ts'
import { isPermitted } from './permissions.ts'

export interface Finalized {
  contests: { contestId: string, kind: OutcomeKind }[]
  /** Issued runoff batches voided, since no runoff was held. */
  batchesVoided: number
}

export async function finalizeElection(client: pg.ClientBase, access: ElectionAccess, build: BuildInfo, reason: string, cleaned: RoundPhases): Promise<Finalized> {
  if (!isPermitted(access.role, 'finalize')) throw new Refusal(403, 'forbidden')
  const next = transition(access.lifecycle, 'finalize')
  if (!next.ok) throw new Refusal(409, next.refusal.replaceAll('-', '_'))
  // The rounds as the clean-up saw them: a round that changed since would
  // have written what the clean-up removed.
  const { rows: rounds } = await client.query<{ kind: RoundKind, phase: string }>('select kind, phase from round where election_id = $1', [access.electionId])
  const unchanged = rounds.length === Object.keys(cleaned).length && rounds.every((round) => cleaned[round.kind] === round.phase)
  if (!unchanged) throw new Refusal(409, 'election_changed')

  const outcomes = await contestOutcomes(client, access.electionId)
  const batchesVoided = access.lifecycle.runoff === null ? await voidRunoffBatches(client, access) : 0
  await inOrder(outcomes, (entry) => client.query(
    `insert into final_outcome (election_id, contest_id, kind, outcome, tally_version, app_version, git_sha)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [access.electionId, entry.contestId, entry.outcome.kind, JSON.stringify(entry.outcome), TALLY_VERSION, build.version, build.gitSha],
  ))
  await client.query(`update election set state = 'final' where id = $1`, [access.electionId])
  const resolved = outcomes.filter((entry) => entry.outcome.kind === 'final').length
  await appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'election.finalized',
    metadata: { reason, resolved, unresolved: outcomes.length - resolved },
  })
  return { contests: outcomes.map((entry) => ({ contestId: entry.contestId, kind: entry.outcome.kind })), batchesVoided }
}

/** Voids every issued runoff batch, each with its event; how many. */
async function voidRunoffBatches(client: pg.ClientBase, access: ElectionAccess): Promise<number> {
  const { rows: batches } = await client.query<{ id: string, voter_group_id: string, keys: number }>(
    `select b.id, b.voter_group_id, b.keys from ${BATCHES_WITH_KEYS} b
      where b.election_id = $1 and b.round_kind = 'runoff' and b.state = 'issued' order by b.id`,
    [access.electionId],
  )
  await voidBatches(client, batches.map((batch) => batch.id))
  await inOrder(batches, (batch) => appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'credential-batch.voided',
    metadata: { batch: batch.id, group: batch.voter_group_id, keys: batch.keys },
  }))
  return batches.length
}
