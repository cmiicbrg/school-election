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
import { readConfiguration, type Configuration } from './configuration.ts'
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

interface RoundRow {
  id: string
  kind: RoundKind
  state: RoundState
}

interface BoxRow {
  id: string
  round_id: string
  contest_id: string
  runoff_pair: string[] | null
  issued: number
  used: number
}

/** The export of the election, read inside the transaction that holds the election's lock. */
export async function buildExport(client: pg.ClientBase, electionId: string, build: BuildInfo, now: Date = new Date()): Promise<BuiltExport> {
  const { rows: [election] } = await client.query<{ id: string, title: string, description: string, state: ElectionState }>(
    'select id, title, description, state from election where id = $1', [electionId],
  )
  if (!election) throw new Error('the election is gone')
  const { rows: rounds } = await client.query<RoundRow>(
    `select id, kind, state from round where election_id = $1 order by (kind = 'regular') desc, kind`, [electionId],
  )
  const configuration = await readConfiguration(client, electionId)
  const { rows: batches } = await client.query<{ id: string, voter_group_id: string, round_kind: RoundKind, state: string, keys: number }>(
    `select b.id, b.voter_group_id, b.round_kind, b.state, (select count(*) from credential c where c.batch_id = b.id)::int as keys
       from credential_batch b where b.election_id = $1 order by b.round_kind, b.state, b.id`, [electionId],
  )
  const exportedRounds = await exportRounds(client, electionId, rounds, configuration)
  const outcomes = rounds.some((round) => round.kind === 'regular' && round.state === 'closed') ? await contestOutcomes(client, electionId) : []
  const snapshots = await exportSnapshots(client, electionId, configuration)
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

/**
 * Every round with its boxes in the configuration's order, each with its
 * counts and, for a closed round, its sealed ballots in content order:
 * the boxes of every round in one query, the ballots of every closed box
 * in one more.
 */
async function exportRounds(client: pg.ClientBase, electionId: string, rounds: readonly RoundRow[], configuration: Configuration): Promise<ExportDocument['rounds']> {
  // One pass over the entitlements of every box, as the turnout query reads them: issued batches' keys count, used ones among them.
  const { rows: boxes } = await client.query<BoxRow>(
    `select rc.id, rc.round_id, rc.contest_id, rc.runoff_pair,
            count(e.credential_id) filter (where b.state = 'issued')::int as issued,
            count(e.credential_id) filter (where b.state = 'issued' and e.consumed)::int as used
       from round_contest rc
       join round r on r.id = rc.round_id
       left join credential_entitlement e on e.round_contest_id = rc.id
       left join credential c on c.id = e.credential_id
       left join credential_batch b on b.id = c.batch_id
      where r.election_id = $1
      group by rc.id, rc.round_id, rc.contest_id, rc.runoff_pair`,
    [electionId],
  )
  const closedBoxes = boxes.filter((box) => rounds.some((round) => round.id === box.round_id && round.state === 'closed')).map((box) => box.id)
  const { rows: ballots } = await client.query<BallotRow & { round_contest_id: string }>(
    'select round_contest_id, kind, ranking from ballot where round_contest_id = any($1)', [closedBoxes],
  )
  return rounds.map((round) => ({
    kind: round.kind,
    state: round.state,
    boxes: configuration.contests
      .flatMap((contest) => boxes.filter((box) => box.round_id === round.id && box.contest_id === contest.id).map((box) => exportBox(contest, box, ballots.filter((ballot) => ballot.round_contest_id === box.id)))),
  }))
}

/** One box with its counts and its ballots in content order, without ids; the pair in ballot order. */
function exportBox(contest: Configuration['contests'][number], box: BoxRow, rows: readonly BallotRow[]): ExportedBox {
  const pair = box.runoff_pair
  const candidateIds = contest.candidates.map((candidate) => candidate.id).filter((id) => pair === null || pair.includes(id))
  const core = { id: contest.id, rulesetId: pair === null ? contest.rulesetId : 'single-choice-v1' as const, candidateIds }
  return {
    id: box.id,
    contestId: box.contest_id,
    runoffPair: pair === null ? null : [candidateIds[0] ?? '', candidateIds[1] ?? ''],
    entitlements: { issued: box.issued, used: box.used },
    ballots: sortedByContent(core, rows).map((ballot) => ({ kind: ballot.kind, ranking: [...ballot.ranking] })),
  }
}

/** The snapshots, in the configuration's order of the contests, the regular round's before the runoff's. */
async function exportSnapshots(client: pg.ClientBase, electionId: string, configuration: Configuration): Promise<ExportDocument['snapshots']> {
  const { rows } = await client.query<{ contest_id: string, kind: RoundKind, input_sha256: string, tally_version: number, app_version: string, git_sha: string, result: unknown, outcome: unknown }>(
    `select rc.contest_id, r.kind, s.input_sha256, s.tally_version, s.app_version, s.git_sha, s.result, s.outcome
       from result_snapshot s join round_contest rc on rc.id = s.round_contest_id join round r on r.id = rc.round_id
      where s.election_id = $1`, [electionId],
  )
  return configuration.contests.flatMap((contest) => (['regular', 'runoff'] as const).flatMap((kind) =>
    rows.filter((row) => row.contest_id === contest.id && row.kind === kind).map((row) => ({
      contestId: row.contest_id,
      round: kind,
      inputSha256: row.input_sha256,
      tallyVersion: row.tally_version,
      appVersion: row.app_version,
      gitSha: row.git_sha,
      result: row.result,
      outcome: row.outcome,
    }))))
}
