// What the API answers, as the pages read it: the response schemas of
// apps/api, in the fields the pages use. The API's allow-lists are the
// authority; a field not here is one the pages do not read.

import type { ContestStatistics, Lifecycle, Outcome, RoundKind, RoundState, RulesetId } from '@school-election/election-core'
import type { Metadata } from './audit-labels.ts'
import type { Role } from './labels.ts'
import type { Permission } from './setup-rules.ts'

export interface ElectionSummary {
  id: string
  title: string
  state: Lifecycle['election']
  role: Role
}

export interface ElectionDetail {
  id: string
  title: string
  description: string
  state: Lifecycle['election']
  role: Role
  permissions: Permission[]
  lifecycle: Lifecycle
}

export interface Candidate {
  id: string
  surname: string
  givenName: string
  /** The app's path of the stored picture (below the base path, as every API path), or null. */
  picture: string | null
}

export interface Contest {
  id: string
  title: string
  rulesetId: RulesetId
  activeSlots: number
  candidates: Candidate[]
}

export interface VoterGroup {
  id: string
  name: string
  contestIds: string[]
}

export interface Configuration {
  contests: Contest[]
  voterGroups: VoterGroup[]
}

export interface Member {
  id: string
  role: Role
  status: 'pending' | 'bound'
  email: string | null
  displayName: string | null
}

export interface Preparation {
  problems: import('./labels.ts').Problem[]
  warnings: import('./labels.ts').Warning[]
  summary: {
    voterGroups: { id: string, name: string, contests: { id: string, title: string }[] }[]
    contests: { id: string, title: string, rulesetId: RulesetId, candidates: number, activeSlots: number }[]
  }
}

export interface BatchSummary {
  id: string
  voterGroupId: string
  roundKind: RoundKind
  state: 'issued' | 'void'
  keys: number
}

/** A batch preparing would void, as the 409 void_required names it. */
export interface StaleBatch {
  id: string
  voterGroupId: string
  keys: number
}

/** How many have voted in a round: counts only. */
export interface Turnout {
  round: RoundState | null
  keys: { issued: number, used: number }
  contests: { contestId: string, issued: number, used: number }[]
}

/** A stored snapshot of a box's result, in the fields the short result reads. */
export interface Snapshot {
  contestId: string
  tallyVersion: number
  appVersion: string
  gitSha: string
  result: { kind: string, statistics: ContestStatistics }
  outcome: unknown
}

export interface RoundResults {
  round: RoundState
  contests: Snapshot[]
}

export interface TestEnded {
  ballots: number
  keys: number
}

export interface RecordedLot {
  id: string
  lotId: string
  candidates: string[]
  drawn: string[]
  reason: string
  actorName: string
  recordedAt: string
}

export interface ContestResult {
  contestId: string
  first: Snapshot
  runoff: Snapshot | null
  lots: RecordedLot[]
  /** election-core's outcome as it stands, or as declared once the election is final. */
  outcome: Outcome
}

export interface ElectionResult {
  contests: ContestResult[]
  finalized: { reason: string, actorName: string, at: string } | null
}

export interface RunoffActivated {
  contests: { contestId: string, candidates: string[] }[]
  keys: number
}

export interface ElectionFinalized {
  state: string
  contests: { contestId: string, kind: string }[]
  batchesVoided: number
}

export interface AuditEvent {
  seq: number
  at: string
  actor: { tid: string, oid: string, name: string }
  action: string
  metadata: Metadata
  prevHash: string | null
  hash: string
}

export type AuditChain
  = | { valid: true, length: number, head: string | null }
    | { valid: false, length: number, index: number, problem: string }

export interface AuditLog {
  events: AuditEvent[]
  chain: AuditChain
}
