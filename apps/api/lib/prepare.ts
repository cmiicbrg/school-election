// Preparing an election fixes its structure: what will be printed, and for
// whom. The summary shows it (the contests each voter group votes in, and
// the candidates and ballot slots of each contest), the problems block it,
// and the warnings point out what a formal election usually has but this
// one lacks. Preparing moves the election to prepared and creates its
// regular round, or brings the round's ballot boxes in line with the
// contests after a return to draft. Unpreparing goes back to draft, only
// before any round has opened, which the lifecycle guard of its route checks.
//
// Keys issued before a return to draft stay valid as long as they still fit:
// preparing again voids the unused regular batches of the voter groups whose
// contests changed meanwhile, so that their keys no longer match what the
// group votes in, and only once the caller confirms it. Every other batch,
// and every candidate correction, leaves the keys as they are.

import type pg from 'pg'
import { transition, type LifecycleAction, type RulesetId } from '@school-election/election-core'
import { BATCHES_WITH_KEYS } from './batch-keys.ts'
import { appendAudit } from './audit.ts'
import { readConfiguration, type Configuration } from './configuration.ts'
import { voidBatches } from './credentials.ts'
import type { Database } from './db.ts'
import { Refusal, type ElectionAccess } from './election-access.ts'
import { inOrder } from './in-order.ts'

/** What stops an election from being prepared. */
export type Problem
  = | { kind: 'no-contests' }
    | { kind: 'no-voter-groups' }
    | { kind: 'contest-without-candidates', contestId: string }
    | { kind: 'contest-without-voter-groups', contestId: string }
    | { kind: 'voter-group-without-contests', voterGroupId: string }

/** What a formal election usually has: a co-admin, two witnesses who have signed in, no open invitations. */
export type Warning
  = | { kind: 'no-co-admin' }
    | { kind: 'too-few-witnesses', witnesses: number }
    | { kind: 'pending-invitations', count: number }

export interface Summary {
  voterGroups: { id: string, name: string, contests: { id: string, title: string }[] }[]
  contests: { id: string, title: string, rulesetId: RulesetId, candidates: number, activeSlots: number }[]
}

export interface Preparation {
  problems: Problem[]
  warnings: Warning[]
  summary: Summary
}

/** A batch that preparing again would void: its keys no longer match the contests its voter group votes in. */
export interface StaleBatch {
  id: string
  voterGroupId: string
  keys: number
}

export type PrepareResult
  = | { prepared: true, summary: Summary, warnings: Warning[] }
    | { prepared: false, problems: Problem[] }
    | { prepared: false, problems: [], staleBatches: StaleBatch[] }

/** The summary, its warnings and what blocks preparing, for the configuration as it is. */
export async function readPreparation(db: Pick<Database, 'query'>, electionId: string): Promise<Preparation> {
  const configuration = await readConfiguration(db, electionId)
  return { problems: problemsOf(configuration), warnings: await warnings(db, electionId), summary: summaryOf(configuration) }
}

function problemsOf({ contests, voterGroups }: Configuration): Problem[] {
  const voted = new Set(voterGroups.flatMap((group) => group.contestIds))
  return [
    ...(contests.length === 0 ? [{ kind: 'no-contests' as const }] : []),
    ...(voterGroups.length === 0 ? [{ kind: 'no-voter-groups' as const }] : []),
    ...contests.filter((contest) => contest.candidates.length === 0).map((contest) => ({ kind: 'contest-without-candidates' as const, contestId: contest.id })),
    ...contests.filter((contest) => !voted.has(contest.id)).map((contest) => ({ kind: 'contest-without-voter-groups' as const, contestId: contest.id })),
    ...voterGroups.filter((group) => group.contestIds.length === 0).map((group) => ({ kind: 'voter-group-without-contests' as const, voterGroupId: group.id })),
  ]
}

function summaryOf({ contests, voterGroups }: Configuration): Summary {
  const titles = new Map(contests.map((contest) => [contest.id, contest.title]))
  return {
    voterGroups: voterGroups.map((group) => ({
      id: group.id,
      name: group.name,
      contests: group.contestIds.map((id) => ({ id, title: titles.get(id) ?? '' })),
    })),
    contests: contests.map((contest) => ({
      id: contest.id,
      title: contest.title,
      rulesetId: contest.rulesetId,
      candidates: contest.candidates.length,
      activeSlots: contest.activeSlots,
    })),
  }
}

async function warnings(db: Pick<Database, 'query'>, electionId: string): Promise<Warning[]> {
  const { rows: [counts] } = await db.query<{ admins: number, witnesses: number, pending: number }>(
    `select count(*) filter (where role = 'admin' and user_id is not null)::int as admins,
            count(*) filter (where role = 'witness' and user_id is not null)::int as witnesses,
            count(*) filter (where user_id is null)::int as pending
       from election_member where election_id = $1`,
    [electionId],
  )
  if (!counts) throw new Error('counting members returned no row')
  return [
    ...(counts.admins === 0 ? [{ kind: 'no-co-admin' as const }] : []),
    ...(counts.witnesses < 2 ? [{ kind: 'too-few-witnesses' as const, witnesses: counts.witnesses }] : []),
    ...(counts.pending > 0 ? [{ kind: 'pending-invitations' as const, count: counts.pending }] : []),
  ]
}

/** true confirms whatever is stale; a list confirms exactly those batches, and nothing if the stale ones differ. */
export type VoidConfirmation = boolean | readonly string[]

/**
 * Prepares the election, inside changeElection: unless something blocks
 * it, creates the regular round or adds the ballot boxes of contests
 * created since, moves the election to prepared and records it. Batches
 * whose keys no longer fit are voided, each recorded, if confirmVoid
 * confirms them: true confirms whatever is stale, a list of batch ids
 * confirms exactly those, so what a person was shown is what is voided,
 * and a change in between makes preparing stop and name the batches
 * again. Without a confirmation, preparing stops and names them.
 */
export async function prepareElection(client: pg.ClientBase, access: ElectionAccess, { confirmVoid = false }: { confirmVoid?: VoidConfirmation } = {}): Promise<PrepareResult> {
  // The configuration triggers hold a share lock on the election's row
  // until their change commits. Taking the row first waits for those and
  // keeps new ones out, so what is read here is what gets prepared, even
  // for a change that did not come through changeElection.
  await client.query('select 1 from election where id = $1 for no key update', [access.electionId])
  const { problems, warnings, summary } = await readPreparation(client, access.electionId)
  if (problems.length > 0) return { prepared: false, problems }
  const stale = await staleBatches(client, access.electionId)
  if (stale.length > 0 && !confirms(confirmVoid, stale)) return { prepared: false, problems: [], staleBatches: stale }
  await voidBatches(client, stale.map((batch) => batch.id))
  await inOrder(stale, (batch) => appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'credential-batch.voided',
    metadata: { batch: batch.id, group: batch.voterGroupId, keys: batch.keys },
  }))
  await client.query(
    `insert into round (election_id, kind) select $1, 'regular'
      where not exists (select 1 from round where election_id = $1 and kind = 'regular')`,
    [access.electionId],
  )
  await client.query(
    `insert into round_contest (election_id, round_id, contest_id)
     select c.election_id, r.id, c.id
       from contest c join round r on r.election_id = c.election_id and r.kind = 'regular'
      where c.election_id = $1
        and not exists (select 1 from round_contest rc where rc.round_id = r.id and rc.contest_id = c.id)`,
    [access.electionId],
  )
  await moveTo(client, access, 'prepare')
  await appendAudit(client, access.electionId, {
    actor: access.actor,
    action: 'election.prepared',
    metadata: {
      contests: summary.contests.length,
      voterGroups: summary.voterGroups.length,
      candidates: summary.contests.reduce((sum, contest) => sum + contest.candidates, 0),
    },
  })
  return { prepared: true, summary, warnings }
}

function confirms(confirmation: VoidConfirmation, stale: readonly StaleBatch[]): boolean {
  if (typeof confirmation === 'boolean') return confirmation
  const confirmed = new Set(confirmation.map((id) => id.toLowerCase()))
  return confirmed.size === stale.length && stale.every((batch) => confirmed.has(batch.id))
}

/**
 * The unused regular batches whose keys are entitled to other contests than
 * their voter group now votes in. A contest removed in the draft takes its
 * entitlements with it, so only a group that gained a contest, or lost one
 * that still exists, has such batches. Runoff batches have no entitlements
 * until the runoff is activated, and are never stale.
 */
async function staleBatches(client: pg.ClientBase, electionId: string): Promise<StaleBatch[]> {
  const { rows } = await client.query<{ id: string, voter_group_id: string, keys: number }>(
    `with batch as (
       select b.id, b.voter_group_id, b.keys from ${BATCHES_WITH_KEYS} b
        where b.election_id = $1 and b.round_kind = 'regular' and b.state = 'issued'
          and not exists (select 1 from credential c join credential_entitlement e on e.credential_id = c.id where c.batch_id = b.id and e.consumed)
     ), entitled as (
       select distinct c.batch_id, rc.contest_id
         from credential c
         join credential_entitlement e on e.credential_id = c.id
         join round_contest rc on rc.id = e.round_contest_id
        where c.batch_id in (select id from batch)
     ), mapped as (
       select b.id as batch_id, m.contest_id from batch b join voter_group_contest m on m.voter_group_id = b.voter_group_id
     )
     select b.id, b.voter_group_id, b.keys
       from batch b
      where exists (select contest_id from entitled e where e.batch_id = b.id except select contest_id from mapped m where m.batch_id = b.id)
         or exists (select contest_id from mapped m where m.batch_id = b.id except select contest_id from entitled e where e.batch_id = b.id)
      order by b.id`,
    [electionId],
  )
  return rows.map((row) => ({ id: row.id, voterGroupId: row.voter_group_id, keys: row.keys }))
}

/** Takes the election back to draft, inside changeElection. Its round and ballot boxes stay, planned, and so do its batches. */
export async function unprepareElection(client: pg.ClientBase, access: ElectionAccess): Promise<void> {
  await moveTo(client, access, 'unprepare')
  await appendAudit(client, access.electionId, { actor: access.actor, action: 'election.unprepared', metadata: {} })
}

async function moveTo(client: pg.ClientBase, access: ElectionAccess, action: LifecycleAction): Promise<void> {
  const next = transition(access.lifecycle, action)
  if (!next.ok) throw new Refusal(409, next.refusal.replaceAll('-', '_'))
  await client.query('update election set state = $2 where id = $1', [access.electionId, next.next.election])
}
