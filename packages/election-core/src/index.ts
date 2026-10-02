// Pure election domain: rulesets, ballot validation, counting.
// No I/O and no framework imports — eslint.config.js enforces that.

/**
 * Version of the counting semantics. Bump it with any change that could make
 * the same configuration and ballots produce a different result; stored
 * results record it so they can be reproduced with the matching code.
 */
export const TALLY_VERSION = 1

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
  validateBallot,
  type BallotError,
  type BallotResult,
  type Contest,
  type ValidBallot,
} from './ballot.ts'

export {
  computeStatistics,
  type CandidateStatistics,
  type ContestStatistics,
} from './statistics.ts'
