// Per-candidate counts over the valid ballots of one contest: the raw figures
// every later result step (majority, runoff selection, derived positions) is
// computed from, and the figures witnesses see in the result derivation.
//
// Integer arithmetic only, and candidates come back in contest order, so the
// output depends on the configuration and the multiset of ballots, never on
// the order the ballots arrive in.

import { contestSlots, type CandidateId, type Contest, type ValidBallot } from './ballot.ts'

export interface CandidateStatistics {
  readonly candidateId: CandidateId
  /** Ballots ranking this candidate in the top slot. */
  readonly firstPlaces: number
  /** rankCounts[i] = ballots placing this candidate in slot i + 1, one entry per active slot. */
  readonly rankCounts: readonly number[]
  /** Sum of statutory slot points over all ballots; unranked earns 0. */
  readonly points: number
}

export interface ContestStatistics {
  readonly validBallots: number
  /** One entry per candidate, in the contest's candidate order. */
  readonly candidates: readonly CandidateStatistics[]
}

export function computeStatistics(contest: Contest, ballots: readonly ValidBallot[]): ContestStatistics {
  const slots = contestSlots(contest)
  const counts = new Map<CandidateId, number[]>(
    contest.candidateIds.map((id) => [id, Array.from({ length: slots.length }, () => 0)]),
  )

  for (const ballot of ballots) {
    // A ValidBallot of another contest would still type-check; refuse it
    // rather than count it into the wrong slots.
    if (ballot.ranking.length !== slots.length) {
      throw new TypeError('ballot does not match the contest\'s active slots')
    }
    ballot.ranking.forEach((id, slot) => {
      const row = counts.get(id)
      if (row === undefined) throw new TypeError('ballot names a candidate outside the contest')
      row[slot] = (row[slot] ?? 0) + 1
    })
  }

  return {
    validBallots: ballots.length,
    candidates: contest.candidateIds.map((candidateId) => {
      const rankCounts = counts.get(candidateId) ?? []
      return {
        candidateId,
        firstPlaces: rankCounts[0] ?? 0,
        rankCounts,
        points: rankCounts.reduce((sum, count, slot) => sum + count * (slots[slot]?.points ?? 0), 0),
      }
    }),
  }
}
