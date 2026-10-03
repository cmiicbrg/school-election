// What the API answers, as the pages read it: the response schemas of
// apps/api, in the fields the pages use. The API's allow-lists are the
// authority; a field not here is one the pages do not read.

import type { Lifecycle, RulesetId, RoundKind } from '@school-election/election-core'
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
  /** The URL of the stored picture, or null. */
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
