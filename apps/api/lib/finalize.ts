// Finalizing an election, inside changeElection, after the clean-up
// (lib/cleanup.ts) ran outside it: by the owner, with a reason, once the
// regular round has closed and while no round is open. The issued runoff
// batches of an election that held no runoff are voided, so no key of the
// election can vote any more; then finalize_election, the
// owner's function and the one way to a declaration, writes the outcome
// of every contest as it stands with the versions that derived it,
// whatever its kind (a botched election ends as it stands, and the reason
// says why), and moves the election to final, after which the triggers
// refuse every change; and the event names the reason and how many
// contests were resolved. The rounds must be in the phases the clean-up
// saw, or nothing is declared.

import type pg from 'pg'
import { TALLY_VERSION, transition, type OutcomeKind, type RoundKind } from '@school-election/election-core'
import type { BuildInfo } from '../config.ts'
import { appendAudit } from './audit.ts'
import { BATCHES_WITH_KEYS } from './batch-keys.ts'
import type { RoundPhases } from './cleanup.ts'
import { voidBatches } from './credentials.ts'
import { Refusal, type ElectionAccess } from './election-access.ts'
import { contestOutcomes } from './outcome.ts'
import { isPermitted } from './permissions.ts'
import { SQLSTATE, sqlState } from './pg-errors.ts'

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
  const declaration = outcomes.map((entry) => ({ contestId: entry.contestId, outcome: entry.outcome }))
  try {
    await client.query('select finalize_election($1, $2::jsonb, $3, $4, $5)', [access.electionId, JSON.stringify(declaration), TALLY_VERSION, build.version, build.gitSha])
  } catch (err) {
    // The function and the triggers refuse only what the guard, re-read under the lock, let through: a change since.
    if (sqlState(err) === SQLSTATE.objectNotInPrerequisiteState) throw new Refusal(409, 'election_changed')
    throw err
  }
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
  for (const batch of batches) {
    await appendAudit(client, access.electionId, {
      actor: access.actor,
      action: 'credential-batch.voided',
      metadata: { batch: batch.id, group: batch.voter_group_id, keys: batch.keys },
    })
  }
  return batches.length
}
