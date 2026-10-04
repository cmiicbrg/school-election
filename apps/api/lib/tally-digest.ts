// What the count sees and the digest of it, pure: the ballots of a box as
// election-core accepts them, from the rows the seal wrote; the canonical
// input of a count, the same text for the same configuration and ballots
// however the rows came back; and its SHA-256. The server tallies with
// these and the offline verifier (lib/export-verify.ts) recomputes with
// them from an export, so this module imports election-core, canonical
// JSON and node:crypto and nothing else, which ESLint keeps.

import { createHash } from 'node:crypto'
import { TALLY_VERSION, validateBallot, type BallotKind, type CastBallot, type Contest } from '@school-election/election-core'
import { canonicalJson } from './canonical-json.ts'

export interface BallotRow {
  kind: BallotKind
  ranking: readonly string[]
}

/** The count met what cannot be: a stored ballot election-core refuses, or a box without its contest. Never a user error. */
export class TallyError extends Error {
  override name = 'TallyError'
}

/**
 * The ballots of one box as election-core accepts them, from the rows the
 * seal wrote: a ranking as stored, "Nein" as such, and an invalid vote as
 * the confirmed incomplete ranking it was (its content is not kept).
 */
export function ballotsOf(contest: Contest, rows: readonly BallotRow[]): CastBallot[] {
  return rows.map((row, index) => {
    const input = row.kind === 'invalid'
      ? { kind: 'ranking', ranking: [], confirmInvalid: true }
      : { kind: row.kind, ranking: [...row.ranking] }
    const checked = validateBallot(contest, input)
    if (!checked.ok) throw new TallyError(`ballot ${index} of contest ${contest.id} does not validate: ${checked.error.kind}`)
    return checked.ballot
  })
}

/** A ballot's place in the content order: the kind, then the ranking as positions on the ballot. */
function contentKey(contest: Contest, ballot: BallotRow): string {
  const position = new Map<string, number>(contest.candidateIds.map((id, index) => [id, index]))
  const positionOf = (id: string): number => position.get(id) ?? -1
  return `${ballot.kind}:${ballot.ranking.map(positionOf).join(',')}`
}

/** Code unit order, the same on every machine; never the locale's. */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** The rows in content order: by kind, then by the ranking as positions on the ballot; the order the count's input and the export use. */
export function sortedByContent<T extends BallotRow>(contest: Contest, rows: readonly T[]): T[] {
  return rows
    .map((row) => ({ row, key: contentKey(contest, row) }))
    .sort((a, b) => compareKeys(a.key, b.key))
    .map(({ row }) => row)
}

/**
 * What the count saw, as canonical JSON: the tally version, the contest
 * (id, ruleset, candidates in ballot order) and the ballots in content
 * order, so the text is the same however the rows came back.
 */
export function tallyInput(contest: Contest, ballots: readonly CastBallot[]): string {
  const sorted = sortedByContent(contest, ballots).map((ballot) => ({ kind: ballot.kind, ranking: [...ballot.ranking] }))
  const input = {
    tallyVersion: TALLY_VERSION,
    contest: { id: contest.id, rulesetId: contest.rulesetId, candidateIds: [...contest.candidateIds] },
    ballots: sorted,
  }
  return canonicalJson(input)
}

/** The SHA-256 of the count's input, in lower-case hex. */
export function inputDigest(contest: Contest, ballots: readonly CastBallot[]): string {
  return createHash('sha256').update(tallyInput(contest, ballots), 'utf8').digest('hex')
}
