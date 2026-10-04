// The lifecycle of an election and its rounds: one state machine that every
// change is checked against, instead of flags scattered over the code. The
// API reads the stored states, asks here whether an action is allowed now,
// and stores the next state in the same transaction.
//
//   election  draft ⇄ prepared → active → final
//   round     planned ⇄ testing, planned → open → closed
//
// An election is prepared once its structure is fixed and keys can be
// issued; unprepare takes it back to draft. A prepared election's regular
// round can be put into test mode, which accepts ballots as an open round
// does but can be ended, which takes the round back to planned with
// nothing kept; while it runs, candidates, its keys, unpreparing and
// opening wait for the test to end. Opening the regular round makes the
// election active. A runoff round exists only once it is activated, which
// opens it, after the regular round has closed. A closed round never
// reopens, and a final election never changes.

export const ELECTION_STATES = ['draft', 'prepared', 'active', 'final'] as const
export type ElectionState = typeof ELECTION_STATES[number]

export const ROUND_KINDS = ['regular', 'runoff'] as const
export type RoundKind = typeof ROUND_KINDS[number]

export const ROUND_STATES = ['planned', 'testing', 'open', 'closed'] as const
export type RoundState = typeof ROUND_STATES[number]

/** An election's state with the states of its rounds. */
export interface Lifecycle {
  readonly election: ElectionState
  /** The regular round: planned until it opens, or testing while the prepared election is tried out. */
  readonly regular: RoundState
  /** The runoff round: null until it is activated, which opens it. */
  readonly runoff: 'open' | 'closed' | null
}

/** Where every election starts. */
export const NEW_ELECTION: Lifecycle = { election: 'draft', regular: 'planned', runoff: null }

export const LIFECYCLE_ACTIONS = [
  'prepare',
  'unprepare',
  'open-regular',
  'close-regular',
  'activate-runoff',
  'close-runoff',
  'finalize',
  'start-test',
  'end-test',
] as const
export type LifecycleAction = typeof LIFECYCLE_ACTIONS[number]

/** Why the lifecycle refuses an action or a change. */
export type LifecycleRefusal
  = | 'election-final' // nothing changes once the election is final
    | 'not-draft' // only a draft can change its structure or be prepared
    | 'not-prepared' // a draft has no keys and cannot open
    | 'voting-started' // the round in question has opened
    | 'round-planned' // the round has not opened yet
    | 'round-open' // the round is open
    | 'round-closed' // the round has closed
    | 'round-testing' // the round is in test mode: end the test first
    | 'no-runoff' // no runoff round has been activated
    | 'runoff-activated' // the runoff round exists already

export type Verdict
  = | { readonly ok: true }
    | { readonly ok: false, readonly refusal: LifecycleRefusal }

export type Transition
  = | { readonly ok: true, readonly next: Lifecycle }
    | { readonly ok: false, readonly refusal: LifecycleRefusal }

const ALLOWED: Verdict = { ok: true }

function refused(refusal: LifecycleRefusal): { readonly ok: false, readonly refusal: LifecycleRefusal } {
  return { ok: false, refusal }
}

/**
 * Whether the states can occur together: a draft election has a planned
 * regular round and no runoff, a prepared one a planned or testing regular
 * round and no runoff; an active one has opened its regular round and has
 * a runoff only after closing it; a final one has no round open.
 */
export function isConsistentLifecycle(lifecycle: Lifecycle): boolean {
  const { election, regular, runoff } = lifecycle
  if (!ELECTION_STATES.includes(election) || !ROUND_STATES.includes(regular)) return false
  if (runoff !== null && runoff !== 'open' && runoff !== 'closed') return false
  switch (election) {
    case 'draft':
      return regular === 'planned' && runoff === null
    case 'prepared':
      return (regular === 'planned' || regular === 'testing') && runoff === null
    case 'active':
      return regular === 'open' ? runoff === null : regular === 'closed'
    case 'final':
      return regular === 'closed' && runoff !== 'open'
  }
}

// An impossible combination is a wiring mistake, never a user error.
function checked(lifecycle: Lifecycle): Lifecycle {
  if (!isConsistentLifecycle(lifecycle)) throw new TypeError(`inconsistent lifecycle ${JSON.stringify(lifecycle)}`)
  return lifecycle
}

function roundState(lifecycle: Lifecycle, round: RoundKind): RoundState | null {
  return round === 'regular' ? lifecycle.regular : lifecycle.runoff
}

/** Why a round in `state` refuses what it is not in the state for. */
function becauseOf(state: RoundState): LifecycleRefusal {
  switch (state) {
    case 'planned':
      return 'round-planned'
    case 'testing':
      return 'round-testing'
    case 'open':
      return 'round-open'
    case 'closed':
      return 'round-closed'
  }
}

/** Contests, voter groups and their mapping, and each contest's ruleset: in a draft only. */
export function canEditStructure(lifecycle: Lifecycle): Verdict {
  const { election } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  return election === 'draft' ? ALLOWED : refused('not-draft')
}

/**
 * Candidates, and the election's title and description: until the regular
 * round opens, so a misspelled name never forces a return to draft; not
 * while a test runs, whose ballots name the candidates.
 */
export function canEditCandidates(lifecycle: Lifecycle): Verdict {
  const { election, regular } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  if (regular === 'testing') return refused('round-testing')
  return regular === 'planned' ? ALLOWED : refused('voting-started')
}

/** Inviting and removing witnesses and co-admins: until the election is final. */
export function canManageMembers(lifecycle: Lifecycle): Verdict {
  return checked(lifecycle).election === 'final' ? refused('election-final') : ALLOWED
}

/**
 * Issuing a batch of keys for a round, or topping one up: once the
 * election is prepared, until that round opens, and not while the round
 * is in test mode, whose votes used some of the keys. Runoff keys can be
 * issued in advance, while the regular round is open and after it has
 * closed; they stay unusable until the runoff is activated.
 */
export function canIssueBatch(lifecycle: Lifecycle, round: RoundKind): Verdict {
  const { election } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  if (election === 'draft') return refused('not-prepared')
  const state = roundState(lifecycle, round)
  if (state === 'testing') return refused('round-testing')
  return state === null || state === 'planned' ? ALLOWED : refused('voting-started')
}

/** Replacing a batch's keys, which makes its printed sheets invalid: in the same window as issuing. */
export function canRotateBatch(lifecycle: Lifecycle, round: RoundKind): Verdict {
  return canIssueBatch(lifecycle, round)
}

/** Casting a ballot: while the round is open, or in test mode. */
export function canCastBallot(lifecycle: Lifecycle, round: RoundKind): Verdict {
  if (checked(lifecycle).election === 'final') return refused('election-final')
  const state = roundState(lifecycle, round)
  if (state === null) return refused('no-runoff')
  if (state === 'open' || state === 'testing') return ALLOWED
  return refused(becauseOf(state))
}

/** Closing a round, which seals it: only while it is open; a test is ended, not closed. */
export function canCloseRound(lifecycle: Lifecycle, round: RoundKind): Verdict {
  if (checked(lifecycle).election === 'final') return refused('election-final')
  const state = roundState(lifecycle, round)
  if (state === null) return refused('no-runoff')
  if (state === 'open') return ALLOWED
  return refused(becauseOf(state))
}

/** A round's result, for every role: only once the round has closed, never while it is open or in test mode. */
export function canShowResults(lifecycle: Lifecycle, round: RoundKind): Verdict {
  const state = roundState(checked(lifecycle), round)
  if (state === null) return refused('no-runoff')
  if (state === 'closed') return ALLOWED
  return refused(becauseOf(state))
}

/** The test result, counted from the test's ballots: exactly while the regular round is in test mode. */
export function canShowTestResult(lifecycle: Lifecycle): Verdict {
  const { election, regular } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  if (regular === 'testing') return ALLOWED
  return refused(becauseOf(regular))
}

/**
 * Opening the regular round: once the election is prepared, from a planned
 * round or from a test, which the opening ends first (the transition
 * open-regular itself needs a planned round).
 */
export function canOpenRegular(lifecycle: Lifecycle): Verdict {
  return whilePrepared(checked(lifecycle).election)
}

/** Deleting an election nobody used: a draft, or a prepared one whose round is planned, with no test running. */
export function canDelete(lifecycle: Lifecycle): Verdict {
  const { election, regular } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  if (election === 'active') return refused('voting-started')
  return regular === 'testing' ? refused('round-testing') : ALLOWED
}

/** Activating the runoff, which opens its round: once, after the regular round has closed. */
export function canActivateRunoff(lifecycle: Lifecycle): Verdict {
  const { election, regular, runoff } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  if (regular !== 'closed') return refused(regular === 'open' ? 'round-open' : 'round-planned')
  return runoff === null ? ALLOWED : refused('runoff-activated')
}

/**
 * Recording the outcome of a lot the officials drew: after the regular
 * round has closed, while no round is open. Which lots a result requires is
 * the result's business, not the lifecycle's.
 */
export function canEnterLot(lifecycle: Lifecycle): Verdict {
  return noRoundOpen(lifecycle)
}

/** Finalizing: after the regular round has closed, while no round is open. */
export function canFinalize(lifecycle: Lifecycle): Verdict {
  return noRoundOpen(lifecycle)
}

/**
 * Exporting the election: once the regular round has closed, while no
 * round is open, so every round in the file is sealed; a final election
 * exports as well, which is why this is not noRoundOpen.
 */
export function canExport(lifecycle: Lifecycle): Verdict {
  const { regular, runoff } = checked(lifecycle)
  if (regular === 'planned' || regular === 'testing') return refused('round-planned')
  return regular === 'open' || runoff === 'open' ? refused('round-open') : ALLOWED
}

function noRoundOpen(lifecycle: Lifecycle): Verdict {
  const { election, regular, runoff } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  if (regular === 'planned' || regular === 'testing') return refused('round-planned')
  return regular === 'open' || runoff === 'open' ? refused('round-open') : ALLOWED
}

/** The lifecycle after `action`, or why the action is not allowed now. Never changes its input. */
export function transition(lifecycle: Lifecycle, action: LifecycleAction): Transition {
  const { election } = checked(lifecycle)
  let verdict: Verdict
  let next: Lifecycle
  switch (action) {
    case 'prepare':
      verdict = canEditStructure(lifecycle)
      next = { ...lifecycle, election: 'prepared' }
      break
    case 'unprepare':
      verdict = whilePreparedAndPlanned(lifecycle)
      next = { ...lifecycle, election: 'draft' }
      break
    case 'open-regular':
      verdict = whilePreparedAndPlanned(lifecycle)
      next = { ...lifecycle, election: 'active', regular: 'open' }
      break
    case 'start-test':
      verdict = whilePreparedAndPlanned(lifecycle)
      next = { ...lifecycle, regular: 'testing' }
      break
    case 'end-test':
      verdict = whilePrepared(election)
      if (verdict.ok && lifecycle.regular !== 'testing') verdict = refused('round-planned')
      next = { ...lifecycle, regular: 'planned' }
      break
    case 'close-regular':
      verdict = canCloseRound(lifecycle, 'regular')
      next = { ...lifecycle, regular: 'closed' }
      break
    case 'activate-runoff':
      verdict = canActivateRunoff(lifecycle)
      next = { ...lifecycle, runoff: 'open' }
      break
    case 'close-runoff':
      verdict = canCloseRound(lifecycle, 'runoff')
      next = { ...lifecycle, runoff: 'closed' }
      break
    case 'finalize':
      verdict = canFinalize(lifecycle)
      next = { ...lifecycle, election: 'final' }
      break
  }
  return verdict.ok ? { ok: true, next: checked(next) } : verdict
}

/** Prepared, and no test running: what unpreparing, opening and starting a test need. */
function whilePreparedAndPlanned(lifecycle: Lifecycle): Verdict {
  const verdict = whilePrepared(lifecycle.election)
  return verdict.ok && lifecycle.regular === 'testing' ? refused('round-testing') : verdict
}

function whilePrepared(election: ElectionState): Verdict {
  switch (election) {
    case 'prepared':
      return ALLOWED
    case 'draft':
      return refused('not-prepared')
    case 'active':
      return refused('voting-started')
    case 'final':
      return refused('election-final')
  }
}
