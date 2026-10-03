// Builds contests and cast ballots for result tests from compact profiles.

import { validateBallot, type CastBallot, type Contest, type RulesetId } from '../../src/index.ts'

export function contest(candidateIds: readonly string[], rulesetId: RulesetId = 'at-school-speaker-v1', id = 'contest'): Contest {
  return { id, rulesetId, candidateIds }
}

/** c1 … cn. */
export function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `c${i + 1}`)
}

/** A complete ranking, "Nein", or a confirmed invalid vote. */
export type BallotSpec = readonly string[] | 'no' | 'invalid'

export function cast(c: Contest, spec: BallotSpec): CastBallot {
  const input = spec === 'no'
    ? { kind: 'no' }
    : { kind: 'ranking', ranking: spec === 'invalid' ? [] : spec, confirmInvalid: spec === 'invalid' }
  const result = validateBallot(c, input)
  if (!result.ok) throw new Error(`test ballot refused: ${result.error.kind}`)
  return result.ballot
}

/** `count` copies of each ballot, e.g. [[41, ['a', 'b', 'c']], [3, 'invalid']]. */
export function profile(c: Contest, rows: readonly (readonly [number, BallotSpec])[]): CastBallot[] {
  return rows.flatMap(([count, spec]) => Array.from({ length: count }, () => cast(c, spec)))
}
