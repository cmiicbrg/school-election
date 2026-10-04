// The shape of an export (lib/export.ts writes it, lib/export-verify.ts
// reads it): the format's name and version, and the document's types.
// Pure, so the verifier can import it: types and constants only.

import type { ElectionState, Lifecycle, Outcome, OutcomeKind, RoundKind, RoundState, RulesetId } from '@school-election/election-core'
import type { AuditChainStatus, AuditEvent } from './audit-chain.ts'
import type { BallotRow } from './tally-digest.ts'

export const EXPORT_FORMAT = 'school-election-export'
export const EXPORT_VERSION = 2

export interface ExportedBox {
  id: string
  contestId: string
  runoffPair: [string, string] | null
  entitlements: { issued: number, used: number }
  /** The sealed ballots of a closed round, in content order, without ids; none for a round that is not closed. */
  ballots: { kind: BallotRow['kind'], ranking: string[] }[]
}

export interface ExportedSnapshot {
  contestId: string
  round: RoundKind
  inputSha256: string
  tallyVersion: number
  appVersion: string
  gitSha: string
  result: unknown
  outcome: unknown
}

export interface ExportedLot {
  id: string
  contestId: string
  lotId: string
  candidates: string[]
  drawn: string[]
  reason: string
  actorName: string
  recordedAt: string
}

/** The outcome of a contest as declared at finalization, with the versions that derived it. */
export interface ExportedFinalOutcome {
  contestId: string
  kind: OutcomeKind
  outcome: Outcome
  tallyVersion: number
  appVersion: string
  gitSha: string
}

export interface ExportDocument {
  format: typeof EXPORT_FORMAT
  version: typeof EXPORT_VERSION
  exportedAt: string
  app: { version: string, gitSha: string, tallyVersion: number }
  election: { id: string, title: string, description: string, state: ElectionState, lifecycle: Lifecycle }
  contests: { id: string, title: string, rulesetId: RulesetId, candidates: { id: string, surname: string, givenName: string }[] }[]
  voterGroups: { id: string, name: string, contestIds: string[] }[]
  batches: { id: string, voterGroupId: string, roundKind: RoundKind, state: string, keys: number }[]
  rounds: { kind: RoundKind, state: RoundState, boxes: ExportedBox[] }[]
  snapshots: ExportedSnapshot[]
  lots: ExportedLot[]
  outcomes: { contestId: string, outcome: Outcome }[]
  /** The declared outcomes of a final election; empty before finalization. */
  finalOutcomes: ExportedFinalOutcome[]
  audit: { events: AuditEvent[], chain: AuditChainStatus }
}
