// The election as a file: an allow-listed document from which anyone can
// recompute every result and check the audit chain offline
// (lib/export-verify.ts), with nothing in it that could group one key's
// ballots or name a key. Every section is read by named columns, never
// select *, so a column added to a table never reaches the file. Sealed
// ballots come without ids and in content order; keys and entitlements
// as counts; pictures not at all. The document is canonical JSON, so the
// same election gives the same bytes and one SHA-256, which the audit
// event records.

import { createHash } from 'node:crypto'
import type pg from 'pg'
import { TALLY_VERSION, type ElectionState, type RoundKind, type RoundState } from '@school-election/election-core'
import type { BuildInfo } from '../config.ts'
import { readAuditChain } from './audit.ts'
import { verifyAuditChain } from './audit-chain.ts'
import { canonicalJson } from './canonical-json.ts'
import { readConfiguration } from './configuration.ts'
import { lifecycleOf } from './election-access.ts'
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportDocument, type ExportedBox } from './export-format.ts'
import { contestOutcomes } from './outcome.ts'
import { sortedByContent, type BallotRow } from './tally-digest.ts'

export { EXPORT_FORMAT, EXPORT_VERSION, type ExportDocument } from './export-format.ts'

export interface BuiltExport {
  document: ExportDocument
  /** The document as canonical JSON: what the file holds. */
  text: string
  sha256: string
  bytes: number
}

/** The export of the election, read inside the transaction that holds the election's lock. */
export async function buildExport(client: pg.ClientBase, electionId: string, build: BuildInfo, now: Date = new Date()): Promise<BuiltExport> {
  const { rows: [election] } = await client.query<{ id: string, title: string, description: string, state: ElectionState }>(
    'select id, title, description, state from election where id = $1', [electionId],
  )
  if (!election) throw new Error('the election is gone')
  const { rows: rounds } = await client.query<{ id: string, kind: RoundKind, state: RoundState }>(
    `select id, kind, state from round where election_id = $1 order by (kind = 'regular') desc, kind`, [electionId],
  )
  const configuration = await readConfiguration(client, electionId)
  const contestOf = new Map(configuration.contests.map((contest) => [contest.id, contest]))
  const { rows: batches } = await client.query<{ id: string, voter_group_id: string, round_kind: RoundKind, state: string, keys: number }>(
    `select b.id, b.voter_group_id, b.round_kind, b.state, (select count(*) from credential c where c.batch_id = b.id)::int as keys
       from credential_batch b where b.election_id = $1 order by b.round_kind, b.state, b.id`, [electionId],
  )
  const exportedRounds: ExportDocument['rounds'] = []
  for (const round of rounds) {
    const { rows: boxes } = await client.query<{ id: string, contest_id: string, runoff_pair: string[] | null, issued: number, used: number }>(
      `select rc.id, rc.contest_id, rc.runoff_pair,
              (select count(*) from credential_entitlement e join credential c on c.id = e.credential_id join credential_batch b on b.id = c.batch_id
                where e.round_contest_id = rc.id and b.state = 'issued')::int as issued,
              (select count(*) from credential_entitlement e join credential c on c.id = e.credential_id join credential_batch b on b.id = c.batch_id
                where e.round_contest_id = rc.id and b.state = 'issued' and e.consumed)::int as used
         from round_contest rc where rc.round_id = $1`, [round.id],
    )
    const ordered = configuration.contests.flatMap((contest) => boxes.filter((box) => box.contest_id === contest.id))
    const exportedBoxes: ExportedBox[] = []
    for (const box of ordered) {
      const contest = contestOf.get(box.contest_id)
      if (!contest) throw new Error(`ballot box ${box.id} belongs to no contest of the election`)
      const candidateIds = box.runoff_pair === null
        ? contest.candidates.map((candidate) => candidate.id)
        : contest.candidates.map((candidate) => candidate.id).filter((id) => box.runoff_pair?.includes(id))
      const ballots = round.state === 'closed'
        ? (await client.query<BallotRow>('select kind, ranking from ballot where round_contest_id = $1', [box.id])).rows
        : []
      const sorted = sortedByContent({ id: contest.id, rulesetId: box.runoff_pair === null ? contest.rulesetId : 'single-choice-v1', candidateIds }, ballots)
      exportedBoxes.push({
        id: box.id,
        contestId: box.contest_id,
        runoffPair: box.runoff_pair === null ? null : [candidateIds[0] ?? '', candidateIds[1] ?? ''],
        entitlements: { issued: box.issued, used: box.used },
        ballots: sorted.map((ballot) => ({ kind: ballot.kind, ranking: [...ballot.ranking] })),
      })
    }
    exportedRounds.push({ kind: round.kind, state: round.state, boxes: exportedBoxes })
  }
  const outcomes = round0Closed(rounds) ? await contestOutcomes(client, electionId) : []
  const { rows: snapshotRows } = await client.query<{ contest_id: string, kind: RoundKind, input_sha256: string, tally_version: number, app_version: string, git_sha: string, result: unknown, outcome: unknown }>(
    `select rc.contest_id, r.kind, s.input_sha256, s.tally_version, s.app_version, s.git_sha, s.result, s.outcome
       from result_snapshot s join round_contest rc on rc.id = s.round_contest_id join round r on r.id = rc.round_id
      where s.election_id = $1`, [electionId],
  )
  const snapshots = configuration.contests.flatMap((contest) => (['regular', 'runoff'] as const).flatMap((kind) =>
    snapshotRows.filter((row) => row.contest_id === contest.id && row.kind === kind).map((row) => ({
      contestId: row.contest_id,
      round: kind,
      inputSha256: row.input_sha256,
      tallyVersion: row.tally_version,
      appVersion: row.app_version,
      gitSha: row.git_sha,
      result: row.result,
      outcome: row.outcome,
    }))))
  const events = await readAuditChain(client, electionId)
  const document: ExportDocument = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    app: { version: build.version, gitSha: build.gitSha, tallyVersion: TALLY_VERSION },
    election: {
      id: election.id,
      title: election.title,
      description: election.description,
      state: election.state,
      lifecycle: lifecycleOf(election.state, {
        regular: rounds.find((round) => round.kind === 'regular')?.state ?? null,
        runoff: rounds.find((round) => round.kind === 'runoff')?.state ?? null,
      }),
    },
    contests: configuration.contests.map((contest) => ({
      id: contest.id,
      title: contest.title,
      rulesetId: contest.rulesetId,
      candidates: contest.candidates.map((candidate) => ({ id: candidate.id, surname: candidate.surname, givenName: candidate.givenName })),
    })),
    voterGroups: configuration.voterGroups.map((group) => ({ id: group.id, name: group.name, contestIds: [...group.contestIds] })),
    batches: batches.map((batch) => ({ id: batch.id, voterGroupId: batch.voter_group_id, roundKind: batch.round_kind, state: batch.state, keys: batch.keys })),
    rounds: exportedRounds,
    snapshots,
    lots: outcomes.flatMap((entry) => entry.lots.map((lot) => ({ contestId: entry.contestId, ...lot }))),
    outcomes: outcomes.map((entry) => ({ contestId: entry.contestId, outcome: entry.outcome })),
    audit: { events, chain: verifyAuditChain(events) },
  }
  const text = canonicalJson(document)
  return { document, text, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), bytes: Buffer.byteLength(text, 'utf8') }
}

/** Whether the regular round has closed: only then are there snapshots and an outcome to export. */
function round0Closed(rounds: readonly { kind: RoundKind, state: RoundState }[]): boolean {
  return rounds.some((round) => round.kind === 'regular' && round.state === 'closed')
}
