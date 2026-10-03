// The lifecycle of an election and its rounds: one state machine that every
// change is checked against, instead of flags scattered over the code. The
// API reads the stored states, asks here whether an action is allowed now,
// and stores the next state in the same transaction.
//
//   election  draft ⇄ prepared → active → final
//   round     planned → open → closed
//
// An election is prepared once its structure is fixed and keys can be
// issued; unprepare takes it back to draft. Opening its regular round makes
// it active. A runoff round exists only once it is activated, which opens
// it, after the regular round has closed. A closed round never reopens, and
// a final election never changes.

export const ELECTION_STATES = ['draft', 'prepared', 'active', 'final'] as const
export type ElectionState = typeof ELECTION_STATES[number]

export const ROUND_KINDS = ['regular', 'runoff'] as const
export type RoundKind = typeof ROUND_KINDS[number]

export const ROUND_STATES = ['planned', 'open', 'closed'] as const
export type RoundState = typeof ROUND_STATES[number]

/** An election's state with the states of its rounds. */
export interface Lifecycle {
  readonly election: ElectionState
  /** The regular round, planned until it opens. */
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
 * Whether the states can occur together: a draft or prepared election has
 * a planned regular round and no runoff; an active one has opened its
 * regular round and has a runoff only after closing it; a final one has
 * no round open.
 */
export function isConsistentLifecycle(lifecycle: Lifecycle): boolean {
  const { election, regular, runoff } = lifecycle
  if (!ELECTION_STATES.includes(election) || !ROUND_STATES.includes(regular)) return false
  if (runoff !== null && runoff !== 'open' && runoff !== 'closed') return false
  switch (election) {
    case 'draft':
    case 'prepared':
      return regular === 'planned' && runoff === null
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

/** Contests, voter groups and their mapping, and each contest's ruleset: in a draft only. */
export function canEditStructure(lifecycle: Lifecycle): Verdict {
  const { election } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  return election === 'draft' ? ALLOWED : refused('not-draft')
}

/**
 * Candidates, and the election's title and description: until the regular
 * round opens, so a misspelled name never forces a return to draft.
 */
export function canEditCandidates(lifecycle: Lifecycle): Verdict {
  const { election, regular } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  return regular === 'planned' ? ALLOWED : refused('voting-started')
}

/** Inviting and removing witnesses and co-admins: until the election is final. */
export function canManageMembers(lifecycle: Lifecycle): Verdict {
  return checked(lifecycle).election === 'final' ? refused('election-final') : ALLOWED
}

/**
 * Issuing a batch of keys for a round, or topping one up: once the
 * election is prepared, until that round opens. Runoff keys can be issued
 * in advance, while the regular round is open and after it has closed;
 * they stay unusable until the runoff is activated.
 */
export function canIssueBatch(lifecycle: Lifecycle, round: RoundKind): Verdict {
  const { election } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  if (election === 'draft') return refused('not-prepared')
  const state = roundState(lifecycle, round)
  return state === null || state === 'planned' ? ALLOWED : refused('voting-started')
}

/** Replacing a batch's keys, which makes its printed sheets invalid: in the same window as issuing. */
export function canRotateBatch(lifecycle: Lifecycle, round: RoundKind): Verdict {
  return canIssueBatch(lifecycle, round)
}

/** Casting a ballot: only while the round is open. */
export function canCastBallot(lifecycle: Lifecycle, round: RoundKind): Verdict {
  if (checked(lifecycle).election === 'final') return refused('election-final')
  const state = roundState(lifecycle, round)
  if (state === null) return refused('no-runoff')
  if (state === 'open') return ALLOWED
  return refused(state === 'planned' ? 'round-planned' : 'round-closed')
}

/** A round's result, for every role: only once the round has closed, never while it is open. */
export function canShowResults(lifecycle: Lifecycle, round: RoundKind): Verdict {
  const state = roundState(checked(lifecycle), round)
  if (state === null) return refused('no-runoff')
  if (state === 'closed') return ALLOWED
  return refused(state === 'planned' ? 'round-planned' : 'round-open')
}

/** Activating the runoff, which opens its round: once, after the regular round has closed. */
export function canActivateRunoff(lifecycle: Lifecycle): Verdict {
  const { election, regular, runoff } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  if (regular !== 'closed') return refused(regular === 'planned' ? 'round-planned' : 'round-open')
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

function noRoundOpen(lifecycle: Lifecycle): Verdict {
  const { election, regular, runoff } = checked(lifecycle)
  if (election === 'final') return refused('election-final')
  if (regular === 'planned') return refused('round-planned')
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
    case 'open-regular':
      verdict = whilePrepared(election)
      next = action === 'unprepare' ? { ...lifecycle, election: 'draft' } : { ...lifecycle, election: 'active', regular: 'open' }
      break
    case 'close-regular':
      verdict = canCastBallot(lifecycle, 'regular')
      next = { ...lifecycle, regular: 'closed' }
      break
    case 'activate-runoff':
      verdict = canActivateRunoff(lifecycle)
      next = { ...lifecycle, runoff: 'open' }
      break
    case 'close-runoff':
      verdict = canCastBallot(lifecycle, 'runoff')
      next = { ...lifecycle, runoff: 'closed' }
      break
    case 'finalize':
      verdict = canFinalize(lifecycle)
      next = { ...lifecycle, election: 'final' }
      break
  }
  return verdict.ok ? { ok: true, next: checked(next) } : verdict
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
