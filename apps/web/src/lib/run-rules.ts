// What the Ablauf section may offer right now: the role's permissions,
// which the API returns with the election, and the lifecycle's guards
// from election-core, asked with the lifecycle the API returns, as
// setup-rules.ts does for the setup sections. A witness has none of the
// controls and sees the same section; a step that is not possible now is
// not offered rather than refused.

import {
  canActivateRunoff,
  canCloseRound,
  canEnterLot,
  canExport,
  canFinalize,
  canOpenRegular,
  canShowResults,
  canShowTestResult,
  transition,
  type Lifecycle,
  type RoundKind,
} from '@school-election/election-core'
import type { Permission } from './setup-rules.ts'

export interface RunRules {
  startTest: boolean
  endTest: boolean
  open: boolean
  closeRegular: boolean
  activateRunoff: boolean
  closeRunoff: boolean
  /** Recording a lot the officials drew: the same people who run rounds, while no round is open. */
  recordLot: boolean
  finalize: boolean
  exportFile: boolean
  /** The round whose turnout the section shows: the one accepting ballots, else the last there is; null before any. */
  turnoutOf: RoundKind | null
  /** The rehearsal's count, while it runs. */
  showTestResult: boolean
  /** The result as it stands, once the regular round has closed. */
  showResult: boolean
}

export function runRules(lifecycle: Lifecycle, permissions: readonly Permission[]): RunRules {
  const may = (permission: Permission) => permissions.includes(permission)
  const runs = may('run-rounds')
  const reads = may('view-results')
  return {
    startTest: runs && transition(lifecycle, 'start-test').ok,
    endTest: runs && transition(lifecycle, 'end-test').ok,
    open: runs && canOpenRegular(lifecycle).ok,
    closeRegular: runs && canCloseRound(lifecycle, 'regular').ok,
    activateRunoff: runs && canActivateRunoff(lifecycle).ok,
    closeRunoff: runs && canCloseRound(lifecycle, 'runoff').ok,
    recordLot: runs && canEnterLot(lifecycle).ok,
    finalize: may('finalize') && canFinalize(lifecycle).ok,
    exportFile: reads && canExport(lifecycle).ok,
    turnoutOf: turnoutOf(lifecycle),
    showTestResult: reads && canShowTestResult(lifecycle).ok,
    showResult: reads && canShowResults(lifecycle, 'regular').ok,
  }
}

/** The runoff once there is one, else the regular round once it has left the planned state. */
export function turnoutOf(lifecycle: Lifecycle): RoundKind | null {
  if (lifecycle.runoff !== null) return 'runoff'
  return lifecycle.regular === 'planned' ? null : 'regular'
}

/** Whether a round accepts ballots now, so the turnout is read again every few seconds. */
export function accepting(lifecycle: Lifecycle): boolean {
  return lifecycle.regular === 'open' || lifecycle.regular === 'testing' || lifecycle.runoff === 'open'
}
