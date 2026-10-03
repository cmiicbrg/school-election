// Pure election domain: rulesets, ballot validation, counting and results.
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
  RULESETS,
  type Ruleset,
  type RulesetId,
  type Slot,
} from './rulesets.ts'

export {
  contestSlots,
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
  resolve,
  type LotDecisionError,
  type Outcome,
  type Resolution,
} from './resolve.ts'

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
