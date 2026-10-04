// What a page may offer right now: the role's permissions, which the API
// returns with the election, and the lifecycle's guards from
// election-core, asked with the lifecycle the API returns. The pages
// render controls from this and nothing else, so a witness sees the same
// pages without a control, and a change that is not possible now is not
// offered rather than refused.

import {
  canEditCandidates,
  canEditStructure,
  canIssueBatch,
  canManageMembers,
  canRotateBatch,
  transition,
  type Lifecycle,
  type RoundKind,
  type RoundState,
} from '@school-election/election-core'
import type { Role } from './labels.ts'

export type Permission = 'view' | 'view-results' | 'configure' | 'prepare' | 'issue-keys' | 'run-rounds' | 'enter-lot' | 'manage-members' | 'finalize' | 'delete-election'

export interface SetupRules {
  /** Contests, voter groups and their mapping, each contest's ruleset. */
  structure: boolean
  /** Candidates, their pictures, the election's title and description. */
  candidates: boolean
  members: boolean
  prepare: boolean
  unprepare: boolean
  /** Issuing a batch for the round, or topping one up. */
  issue: Readonly<Record<RoundKind, boolean>>
  /** Replacing an issued batch of the round. */
  replace: Readonly<Record<RoundKind, boolean>>
}

export function setupRules(lifecycle: Lifecycle, permissions: readonly Permission[]): SetupRules {
  const may = (permission: Permission) => permissions.includes(permission)
  return {
    structure: may('configure') && canEditStructure(lifecycle).ok,
    candidates: may('configure') && canEditCandidates(lifecycle).ok,
    members: may('manage-members') && canManageMembers(lifecycle).ok,
    prepare: may('prepare') && transition(lifecycle, 'prepare').ok,
    unprepare: may('prepare') && transition(lifecycle, 'unprepare').ok,
    issue: { regular: may('issue-keys') && canIssueBatch(lifecycle, 'regular').ok, runoff: may('issue-keys') && canIssueBatch(lifecycle, 'runoff').ok },
    replace: { regular: may('issue-keys') && canRotateBatch(lifecycle, 'regular').ok, runoff: may('issue-keys') && canRotateBatch(lifecycle, 'runoff').ok },
  }
}

/**
 * Whether a member in `role` may read a batch's keys now: the owner and
 * co-admins always, a witness once the batch's round has closed or the
 * election is final (apps/api/lib/credentials.ts).
 */
export function mayReadKeys(role: Role, lifecycle: Lifecycle, kind: RoundKind): boolean {
  const round: RoundState | null = kind === 'regular' ? lifecycle.regular : lifecycle.runoff
  return role !== 'witness' || round === 'closed' || lifecycle.election === 'final'
}
