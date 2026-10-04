import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import {
  canActivateRunoff,
  canCastBallot,
  canCloseRound,
  canDelete,
  canEditCandidates,
  canEditStructure,
  canEnterLot,
  canExport,
  canFinalize,
  canIssueBatch,
  canManageMembers,
  canOpenRegular,
  canRotateBatch,
  canShowResults,
  canShowTestResult,
  ELECTION_STATES,
  isConsistentLifecycle,
  LIFECYCLE_ACTIONS,
  NEW_ELECTION,
  ROUND_STATES,
  transition,
  type Lifecycle,
  type LifecycleAction,
  type LifecycleRefusal,
  type Verdict,
} from '../src/index.ts'

// Every state an election can be in.
const STATES = {
  draft: { election: 'draft', regular: 'planned', runoff: null },
  prepared: { election: 'prepared', regular: 'planned', runoff: null },
  testing: { election: 'prepared', regular: 'testing', runoff: null },
  regularOpen: { election: 'active', regular: 'open', runoff: null },
  regularClosed: { election: 'active', regular: 'closed', runoff: null },
  runoffOpen: { election: 'active', regular: 'closed', runoff: 'open' },
  runoffClosed: { election: 'active', regular: 'closed', runoff: 'closed' },
  final: { election: 'final', regular: 'closed', runoff: null },
  finalAfterRunoff: { election: 'final', regular: 'closed', runoff: 'closed' },
} as const satisfies Record<string, Lifecycle>

type StateName = keyof typeof STATES
const NAMES = Object.keys(STATES) as StateName[]
const nameOf = (lifecycle: Lifecycle) => NAMES.find((name) => isDeepStrictEqual(STATES[name], lifecycle))

// Each action in each state: `→ next` or the typed refusal. Columns follow
// LIFECYCLE_ACTIONS: prepare, unprepare, open-regular, close-regular,
// activate-runoff, close-runoff, finalize, start-test, end-test.
type Expected = `→ ${StateName}` | LifecycleRefusal
const FINAL_ROW: Expected[] = Array<Expected>(9).fill('election-final')
const TRANSITIONS: Record<StateName, Expected[]> = {
  draft: ['→ prepared', 'not-prepared', 'not-prepared', 'round-planned', 'round-planned', 'no-runoff', 'round-planned', 'not-prepared', 'not-prepared'],
  prepared: ['not-draft', '→ draft', '→ regularOpen', 'round-planned', 'round-planned', 'no-runoff', 'round-planned', '→ testing', 'round-planned'],
  testing: ['not-draft', 'round-testing', 'round-testing', 'round-testing', 'round-planned', 'no-runoff', 'round-planned', 'round-testing', '→ prepared'],
  regularOpen: ['not-draft', 'voting-started', 'voting-started', '→ regularClosed', 'round-open', 'no-runoff', 'round-open', 'voting-started', 'voting-started'],
  regularClosed: ['not-draft', 'voting-started', 'voting-started', 'round-closed', '→ runoffOpen', 'no-runoff', '→ final', 'voting-started', 'voting-started'],
  runoffOpen: ['not-draft', 'voting-started', 'voting-started', 'round-closed', 'runoff-activated', '→ runoffClosed', 'round-open', 'voting-started', 'voting-started'],
  runoffClosed: ['not-draft', 'voting-started', 'voting-started', 'round-closed', 'runoff-activated', 'round-closed', '→ finalAfterRunoff', 'voting-started', 'voting-started'],
  final: FINAL_ROW,
  finalAfterRunoff: FINAL_ROW,
}

const expected = (row: StateName, action: LifecycleAction) => TRANSITIONS[row][LIFECYCLE_ACTIONS.indexOf(action)]

function outcome(lifecycle: Lifecycle, action: LifecycleAction): Expected {
  const result = transition(lifecycle, action)
  if (!result.ok) return result.refusal
  const next = nameOf(result.next)
  assert.ok(next, `${action} led to an unknown state ${JSON.stringify(result.next)}`)
  return `→ ${next}`
}

// Each guard in each state: 'ok' or the typed refusal.
type Allowed = 'ok' | LifecycleRefusal
interface Guard {
  name: string
  check: (lifecycle: Lifecycle) => Verdict
  expected: Record<StateName, Allowed>
}

const rows = (values: Allowed[]): Record<StateName, Allowed> =>
  Object.fromEntries(NAMES.map((name, i) => [name, values[i] ?? assert.fail(`no value for ${name}`)])) as Record<StateName, Allowed>

// Columns: draft, prepared, testing, regularOpen, regularClosed,
// runoffOpen, runoffClosed, final, finalAfterRunoff.
const GUARDS: Guard[] = [
  {
    name: 'canEditStructure',
    check: canEditStructure,
    expected: rows(['ok', 'not-draft', 'not-draft', 'not-draft', 'not-draft', 'not-draft', 'not-draft', 'election-final', 'election-final']),
  },
  {
    name: 'canEditCandidates',
    check: canEditCandidates,
    expected: rows(['ok', 'ok', 'round-testing', 'voting-started', 'voting-started', 'voting-started', 'voting-started', 'election-final', 'election-final']),
  },
  {
    name: 'canManageMembers',
    check: canManageMembers,
    expected: rows(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'election-final', 'election-final']),
  },
  {
    name: 'canIssueBatch regular',
    check: (l) => canIssueBatch(l, 'regular'),
    expected: rows(['not-prepared', 'ok', 'round-testing', 'voting-started', 'voting-started', 'voting-started', 'voting-started', 'election-final', 'election-final']),
  },
  {
    name: 'canIssueBatch runoff',
    check: (l) => canIssueBatch(l, 'runoff'),
    expected: rows(['not-prepared', 'ok', 'ok', 'ok', 'ok', 'voting-started', 'voting-started', 'election-final', 'election-final']),
  },
  {
    name: 'canCastBallot regular',
    check: (l) => canCastBallot(l, 'regular'),
    expected: rows(['round-planned', 'round-planned', 'ok', 'ok', 'round-closed', 'round-closed', 'round-closed', 'election-final', 'election-final']),
  },
  {
    name: 'canCastBallot runoff',
    check: (l) => canCastBallot(l, 'runoff'),
    expected: rows(['no-runoff', 'no-runoff', 'no-runoff', 'no-runoff', 'no-runoff', 'ok', 'round-closed', 'election-final', 'election-final']),
  },
  {
    name: 'canCloseRound regular',
    check: (l) => canCloseRound(l, 'regular'),
    expected: rows(['round-planned', 'round-planned', 'round-testing', 'ok', 'round-closed', 'round-closed', 'round-closed', 'election-final', 'election-final']),
  },
  {
    name: 'canCloseRound runoff',
    check: (l) => canCloseRound(l, 'runoff'),
    expected: rows(['no-runoff', 'no-runoff', 'no-runoff', 'no-runoff', 'no-runoff', 'ok', 'round-closed', 'election-final', 'election-final']),
  },
  {
    name: 'canShowResults regular',
    check: (l) => canShowResults(l, 'regular'),
    expected: rows(['round-planned', 'round-planned', 'round-testing', 'round-open', 'ok', 'ok', 'ok', 'ok', 'ok']),
  },
  {
    name: 'canShowResults runoff',
    check: (l) => canShowResults(l, 'runoff'),
    expected: rows(['no-runoff', 'no-runoff', 'no-runoff', 'no-runoff', 'no-runoff', 'round-open', 'ok', 'no-runoff', 'ok']),
  },
  {
    name: 'canShowTestResult',
    check: canShowTestResult,
    expected: rows(['round-planned', 'round-planned', 'ok', 'round-open', 'round-closed', 'round-closed', 'round-closed', 'election-final', 'election-final']),
  },
  {
    name: 'canOpenRegular',
    check: canOpenRegular,
    expected: rows(['not-prepared', 'ok', 'ok', 'voting-started', 'voting-started', 'voting-started', 'voting-started', 'election-final', 'election-final']),
  },
  {
    name: 'canDelete',
    check: canDelete,
    expected: rows(['ok', 'ok', 'round-testing', 'voting-started', 'voting-started', 'voting-started', 'voting-started', 'election-final', 'election-final']),
  },
  {
    name: 'canActivateRunoff',
    check: canActivateRunoff,
    expected: rows(['round-planned', 'round-planned', 'round-planned', 'round-open', 'ok', 'runoff-activated', 'runoff-activated', 'election-final', 'election-final']),
  },
  {
    name: 'canEnterLot',
    check: canEnterLot,
    expected: rows(['round-planned', 'round-planned', 'round-planned', 'round-open', 'ok', 'round-open', 'ok', 'election-final', 'election-final']),
  },
  {
    name: 'canFinalize',
    check: canFinalize,
    expected: rows(['round-planned', 'round-planned', 'round-planned', 'round-open', 'ok', 'round-open', 'ok', 'election-final', 'election-final']),
  },
  {
    name: 'canExport',
    check: canExport,
    expected: rows(['round-planned', 'round-planned', 'round-planned', 'round-open', 'ok', 'round-open', 'ok', 'ok', 'ok']),
  },
]

test('every action in every state is either the expected transition or a typed refusal', () => {
  for (const name of NAMES) {
    for (const action of LIFECYCLE_ACTIONS) {
      assert.equal(outcome(STATES[name], action), expected(name, action), `${action} in ${name}`)
    }
  }
})

test('exactly the nine listed states are consistent, and every function refuses any other combination', () => {
  const consistent: Lifecycle[] = []
  for (const election of ELECTION_STATES) {
    for (const regular of ROUND_STATES) {
      for (const runoff of [null, 'open', 'closed'] as const) {
        const lifecycle: Lifecycle = { election, regular, runoff }
        if (isConsistentLifecycle(lifecycle)) {
          consistent.push(lifecycle)
          continue
        }
        assert.throws(() => transition(lifecycle, 'prepare'), TypeError)
        for (const guard of GUARDS) assert.throws(() => guard.check(lifecycle), TypeError, guard.name)
      }
    }
  }
  assert.deepEqual(consistent.map(nameOf).sort(), [...NAMES].sort())
  assert.equal(isConsistentLifecycle({ ...NEW_ELECTION, runoff: 'planned' } as unknown as Lifecycle), false)
  assert.equal(isConsistentLifecycle({ ...NEW_ELECTION, election: 'open' } as unknown as Lifecycle), false)
  assert.deepEqual(NEW_ELECTION, STATES.draft)
})

test('every state is reachable from a new election; the only ways back are unprepare and ending a test, and a closed round never reopens', () => {
  const reached = new Set<StateName>(['draft'])
  const queue: StateName[] = ['draft']
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    const before: Lifecycle = STATES[name]
    for (const action of LIFECYCLE_ACTIONS) {
      const result = transition(before, action)
      if (!result.ok) continue
      const next = nameOf(result.next)
      assert.ok(next)
      const after = result.next
      if (action !== 'unprepare' && action !== 'end-test') assert.ok(rank(after) > rank(before), `${action} from ${name} goes back`)
      if (before.regular === 'closed') assert.equal(after.regular, 'closed')
      if (before.runoff === 'closed') assert.equal(after.runoff, 'closed')
      if (!reached.has(next)) {
        reached.add(next)
        queue.push(next)
      }
    }
  }
  assert.deepEqual([...reached].sort(), [...NAMES].sort())
})

// How far an election has come: each forward action increases it.
function rank({ election, regular, runoff }: Lifecycle): number {
  return ELECTION_STATES.indexOf(election) * 12 + ROUND_STATES.indexOf(regular) * 3 + [null, 'open', 'closed'].indexOf(runoff)
}

const allowed = (verdict: Verdict): Allowed => verdict.ok ? 'ok' : verdict.refusal

test('every guard in every state is either allowed or a typed refusal', () => {
  for (const guard of GUARDS) {
    for (const name of NAMES) {
      assert.equal(allowed(guard.check(STATES[name])), guard.expected[name], `${guard.name} in ${name}`)
    }
  }
})

test('rotating a batch has the same window as issuing one', () => {
  for (const name of NAMES) {
    for (const round of ['regular', 'runoff'] as const) {
      assert.deepEqual(canRotateBatch(STATES[name], round), canIssueBatch(STATES[name], round), `${round} in ${name}`)
    }
  }
})

test('voting is refused in draft and prepared and after the round has closed', () => {
  for (const name of ['draft', 'prepared'] as const) {
    assert.deepEqual(canCastBallot(STATES[name], 'regular'), { ok: false, refusal: 'round-planned' })
  }
  assert.deepEqual(canCastBallot(STATES.regularClosed, 'regular'), { ok: false, refusal: 'round-closed' })
  assert.deepEqual(canCastBallot(STATES.runoffClosed, 'runoff'), { ok: false, refusal: 'round-closed' })
  assert.deepEqual(transition(STATES.regularClosed, 'close-regular'), { ok: false, refusal: 'round-closed' })
})

test('no result is shown while its round is open, to anyone', () => {
  assert.deepEqual(canShowResults(STATES.regularOpen, 'regular'), { ok: false, refusal: 'round-open' })
  assert.deepEqual(canShowResults(STATES.runoffOpen, 'runoff'), { ok: false, refusal: 'round-open' })
  // The first round's result stays readable while the runoff runs.
  assert.deepEqual(canShowResults(STATES.runoffOpen, 'regular'), { ok: true })
})

test('a runoff that does not exist cannot be activated, voted in or closed', () => {
  for (const name of ['draft', 'prepared'] as const) {
    assert.deepEqual(transition(STATES[name], 'activate-runoff'), { ok: false, refusal: 'round-planned' })
  }
  assert.deepEqual(transition(STATES.regularOpen, 'activate-runoff'), { ok: false, refusal: 'round-open' })
  assert.deepEqual(transition(STATES.runoffOpen, 'activate-runoff'), { ok: false, refusal: 'runoff-activated' })
  assert.deepEqual(transition(STATES.runoffClosed, 'activate-runoff'), { ok: false, refusal: 'runoff-activated' })
  for (const name of ['draft', 'prepared', 'regularOpen', 'regularClosed'] as const) {
    assert.deepEqual(transition(STATES[name], 'close-runoff'), { ok: false, refusal: 'no-runoff' })
    assert.deepEqual(canCastBallot(STATES[name], 'runoff'), { ok: false, refusal: 'no-runoff' })
  }
})

test('once final, every change is refused', () => {
  for (const name of ['final', 'finalAfterRunoff'] as const) {
    for (const action of LIFECYCLE_ACTIONS) {
      assert.deepEqual(transition(STATES[name], action), { ok: false, refusal: 'election-final' }, `${action} in ${name}`)
    }
    // Reading a result and exporting are not changes: a final election is read and exported.
    for (const guard of GUARDS.filter((g) => !g.name.startsWith('canShowResults') && g.name !== 'canExport')) {
      assert.deepEqual(guard.check(STATES[name]), { ok: false, refusal: 'election-final' }, `${guard.name} in ${name}`)
    }
    assert.deepEqual(canExport(STATES[name]), { ok: true }, `canExport in ${name}`)
  }
})

test('runoff keys can be issued until the runoff opens, including while round 1 is open or closed', () => {
  for (const name of ['prepared', 'regularOpen', 'regularClosed'] as const) {
    assert.deepEqual(canIssueBatch(STATES[name], 'runoff'), { ok: true }, name)
  }
  assert.deepEqual(canIssueBatch(STATES.runoffOpen, 'runoff'), { ok: false, refusal: 'voting-started' })
  // Regular keys only until the regular round opens.
  assert.deepEqual(canIssueBatch(STATES.regularOpen, 'regular'), { ok: false, refusal: 'voting-started' })
})

test('candidates can be corrected until the first round opens, the structure only in a draft', () => {
  assert.deepEqual(canEditCandidates(STATES.prepared), { ok: true })
  assert.deepEqual(canEditCandidates(STATES.regularOpen), { ok: false, refusal: 'voting-started' })
  assert.deepEqual(canEditStructure(STATES.prepared), { ok: false, refusal: 'not-draft' })
  // Unprepare reopens the structure only before any round has opened.
  assert.deepEqual(transition(STATES.prepared, 'unprepare'), { ok: true, next: STATES.draft })
  assert.deepEqual(transition(STATES.regularOpen, 'unprepare'), { ok: false, refusal: 'voting-started' })
})

test('a test runs on a prepared election: it accepts ballots but is ended, not closed, and freezes candidates, its keys, unpreparing and opening until then', () => {
  assert.deepEqual(transition(STATES.prepared, 'start-test'), { ok: true, next: STATES.testing })
  assert.deepEqual(transition(STATES.testing, 'end-test'), { ok: true, next: STATES.prepared })
  assert.deepEqual(canCastBallot(STATES.testing, 'regular'), { ok: true })
  assert.deepEqual(canShowTestResult(STATES.testing), { ok: true })
  assert.deepEqual(canShowResults(STATES.testing, 'regular'), { ok: false, refusal: 'round-testing' })
  for (const action of ['unprepare', 'open-regular', 'close-regular', 'start-test'] as const) {
    assert.deepEqual(transition(STATES.testing, action), { ok: false, refusal: 'round-testing' }, action)
  }
  // Opening from a test is allowed as a step that ends the test first.
  assert.deepEqual(canOpenRegular(STATES.testing), { ok: true })
  assert.deepEqual(canEditCandidates(STATES.testing), { ok: false, refusal: 'round-testing' })
  assert.deepEqual(canIssueBatch(STATES.testing, 'regular'), { ok: false, refusal: 'round-testing' })
  assert.deepEqual(canIssueBatch(STATES.testing, 'runoff'), { ok: true })
  assert.deepEqual(canManageMembers(STATES.testing), { ok: true })
  assert.deepEqual(canDelete(STATES.testing), { ok: false, refusal: 'round-testing' })
  assert.deepEqual(transition(STATES.prepared, 'end-test'), { ok: false, refusal: 'round-planned' })
  assert.deepEqual(transition(STATES.regularOpen, 'start-test'), { ok: false, refusal: 'voting-started' })
})

test('transition never changes its input', () => {
  for (const name of NAMES) {
    const frozen = Object.freeze({ ...STATES[name] })
    for (const action of LIFECYCLE_ACTIONS) {
      const result = transition(frozen, action)
      if (result.ok) assert.notEqual(result.next, frozen)
    }
    assert.deepEqual(frozen, STATES[name])
  }
})
