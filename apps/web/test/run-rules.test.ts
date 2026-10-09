import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEW_ELECTION, type Lifecycle } from '@school-election/election-core'
import { accepting, runoffState, runRules, turnoutOf, type RunRules } from '../src/lib/run-rules.ts'
import { ERROR_MESSAGES } from '../src/lib/api-rules.ts'
import type { Permission } from '../src/lib/setup-rules.ts'

const OWNER: Permission[] = ['view', 'view-results', 'configure', 'prepare', 'issue-keys', 'run-rounds', 'manage-witnesses', 'manage-co-admins', 'finalize', 'delete-election']
const ADMIN: Permission[] = OWNER.filter((permission) => permission !== 'manage-co-admins' && permission !== 'finalize' && permission !== 'delete-election')
const WITNESS: Permission[] = ['view', 'view-results']

const DRAFT: Lifecycle = NEW_ELECTION
const PREPARED: Lifecycle = { election: 'prepared', regular: 'planned', runoff: null }
const TESTING: Lifecycle = { election: 'prepared', regular: 'testing', runoff: null }
const OPEN: Lifecycle = { election: 'active', regular: 'open', runoff: null }
const CLOSED: Lifecycle = { election: 'active', regular: 'closed', runoff: null }
const RUNOFF: Lifecycle = { election: 'active', regular: 'closed', runoff: 'open' }
const RUNOFF_CLOSED: Lifecycle = { election: 'active', regular: 'closed', runoff: 'closed' }
const FINAL: Lifecycle = { election: 'final', regular: 'closed', runoff: null }

const NOTHING: RunRules = {
  startTest: false, endTest: false, open: false, closeRegular: false, activateRunoff: false, closeRunoff: false,
  recordLot: false, finalize: false, exportFile: false, turnoutOf: null, showTestResult: false, showResult: false,
}

test('the owner: a rehearsal and the opening while prepared, the close while open, the runoff and the lots after the close, finalizing and the export while no round is open', () => {
  assert.deepEqual(runRules(DRAFT, OWNER), NOTHING)
  assert.deepEqual(runRules(PREPARED, OWNER), { ...NOTHING, startTest: true, open: true })
  assert.deepEqual(runRules(TESTING, OWNER), { ...NOTHING, endTest: true, open: true, turnoutOf: 'regular', showTestResult: true })
  assert.deepEqual(runRules(OPEN, OWNER), { ...NOTHING, closeRegular: true, turnoutOf: 'regular' })
  assert.deepEqual(runRules(CLOSED, OWNER), { ...NOTHING, activateRunoff: true, recordLot: true, finalize: true, exportFile: true, turnoutOf: 'regular', showResult: true })
  assert.deepEqual(runRules(RUNOFF, OWNER), { ...NOTHING, closeRunoff: true, turnoutOf: 'runoff', showResult: true })
  assert.deepEqual(runRules(RUNOFF_CLOSED, OWNER), { ...NOTHING, recordLot: true, finalize: true, exportFile: true, turnoutOf: 'runoff', showResult: true })
  assert.deepEqual(runRules(FINAL, OWNER), { ...NOTHING, exportFile: true, turnoutOf: 'regular', showResult: true })
})

test('a co-admin runs the rounds and records lots but never finalizes; a witness reads the turnout, the result and the export and has no control', () => {
  for (const lifecycle of [PREPARED, TESTING, OPEN, CLOSED, RUNOFF, RUNOFF_CLOSED, FINAL]) {
    const owner = runRules(lifecycle, OWNER)
    assert.deepEqual(runRules(lifecycle, ADMIN), { ...owner, finalize: false }, lifecycle.regular)
    assert.deepEqual(runRules(lifecycle, WITNESS), {
      ...NOTHING, turnoutOf: owner.turnoutOf, showTestResult: owner.showTestResult, showResult: owner.showResult, exportFile: owner.exportFile,
    }, lifecycle.regular)
  }
})

test('the turnout shown is the round accepting ballots, else the last there is; a round accepting ballots is read again and again', () => {
  assert.equal(turnoutOf(PREPARED), null)
  assert.equal(turnoutOf(TESTING), 'regular')
  assert.equal(turnoutOf(CLOSED), 'regular')
  assert.equal(turnoutOf(RUNOFF), 'runoff')
  assert.equal(turnoutOf(RUNOFF_CLOSED), 'runoff')
  assert.deepEqual([DRAFT, PREPARED, TESTING, OPEN, CLOSED, RUNOFF, RUNOFF_CLOSED, FINAL].map(accepting), [false, false, true, true, false, true, false, false])
})

test('every refusal of the election day has its sentence', () => {
  for (const code of ['lot_required', 'lot_not_required', 'duplicate_lot', 'not_the_tied_set', 'cleanup_blocked', 'wal_retained', 'election_changed', 'no_runoff']) {
    assert.ok(ERROR_MESSAGES[code], code)
  }
})

test('the runoff is offered from the outcomes: the pairs of the contests that need one, and not while another contest\'s runoff entry still waits for a lot', () => {
  const pair = { kind: 'runoff-required' as const, runoffCandidates: ['p', 'r'] as const, trace: [] }
  const entryLot = { kind: 'lot-required' as const, lots: [{ id: 'runoff-entry' as const, reason: 'runoff-entry' as const, candidates: ['q', 'r'], seats: 1, qualified: ['p'] }], positions: [], trace: [] }
  const positionsLot = { kind: 'lot-required' as const, lots: [{ id: 'positions:deputy' as const, reason: 'positions' as const, candidates: ['q', 'r'], positions: ['deputy'] }], positions: [], trace: [] }
  const final = { kind: 'final' as const, positions: [], trace: [] }
  assert.deepEqual(runoffState([{ contestId: 'a', outcome: pair }, { contestId: 'b', outcome: final }]), { pairs: [{ contestId: 'a', pair: ['p', 'r'] }], waiting: [] })
  assert.deepEqual(runoffState([{ contestId: 'a', outcome: pair }, { contestId: 'b', outcome: entryLot }]), { pairs: [{ contestId: 'a', pair: ['p', 'r'] }], waiting: ['b'] })
  assert.deepEqual(runoffState([{ contestId: 'a', outcome: pair }, { contestId: 'b', outcome: positionsLot }]), { pairs: [{ contestId: 'a', pair: ['p', 'r'] }], waiting: [] }, 'a positions lot does not hold the runoff back')
  assert.deepEqual(runoffState([{ contestId: 'b', outcome: entryLot }]), { pairs: [], waiting: ['b'] })
})
