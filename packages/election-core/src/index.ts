// Pure election domain: rulesets, ballot validation, counting, results,
// the election lifecycle and the voting key format.
// No I/O and no framework imports — eslint.config.js enforces that.

/**
 * Version of the counting semantics. Bump it with any change that could make
 * the same configuration and ballots produce a different result; stored
 * results record it so they can be reproduced with the matching code.
 */
export const TALLY_VERSION = 2

export {
  activeSlots,
  isRulesetId,
  RULESET_IDS,
  RULESETS,
  type Ruleset,
  type RulesetId,
  type Slot,
} from './rulesets.ts'

export {
  BALLOT_KINDS,
  contestKey,
  contestSlots,
  isBallotFor,
  offersNo,
  validateBallot,
  type BallotError,
  type BallotKind,
  type BallotResult,
  type Contest,
  type CastBallot,
} from './ballot.ts'

export {
  computeStatistics,
  type CandidateStatistics,
  type ContestStatistics,
} from './statistics.ts'

export {
  firstRoundResult,
  runoffResult,
  type FirstRoundResult,
  type RunoffResult,
} from './result.ts'

export {
  OUTCOME_KINDS,
  pollOutcome,
  resolve,
  type LotDecisionError,
  type Outcome,
  type OutcomeKind,
  type Resolution,
} from './resolve.ts'

export {
  canActivateRunoff,
  canCastBallot,
  canEditCandidates,
  canEditStructure,
  canEnterLot,
  canFinalize,
  canIssueBatch,
  canManageMembers,
  canRotateBatch,
  canShowResults,
  ELECTION_STATES,
  isConsistentLifecycle,
  LIFECYCLE_ACTIONS,
  NEW_ELECTION,
  ROUND_KINDS,
  ROUND_STATES,
  transition,
  type ElectionState,
  type Lifecycle,
  type LifecycleAction,
  type LifecycleRefusal,
  type RoundKind,
  type RoundState,
  type Transition,
  type Verdict,
} from './lifecycle.ts'

export {
  formatKey,
  generateKey,
  KEY_ALPHABET,
  KEY_LENGTH,
  KEY_RANDOM_BYTES,
  KEY_RANDOM_SYMBOLS,
  keyUrl,
  normalizeKey,
  parseKey,
  type KeyProblem,
  type ParsedKey,
} from './credential-key.ts'

export type {
  CandidateValue,
  CommitteeReason,
  LotDecision,
  LotRequest,
  Position,
  PositionsLot,
  RunoffEntryLot,
  TraceStep,
} from './trace.ts'
