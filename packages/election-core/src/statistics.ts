// Per-candidate counts over the cast ballots of one contest: the raw figures
// every later result step (majority, runoff selection, derived positions) is
// computed from, and the figures witnesses see in the result derivation.
// The majority base is the number of valid ballots: complete rankings plus
// "Nein" votes in a single-candidate contest. Blank ballots are invalid
// votes, counted on their own, and give nobody points or a first place.
//
// Integer arithmetic only, and candidates come back in contest order, so the
// output depends on the configuration and the multiset of ballots, never on
// the order the ballots arrive in.

import { contestKey, contestSlots, isBallotFor, type CastBallot, type Contest } from './ballot.ts'

export interface CandidateStatistics {
  readonly candidateId: string
  /** Ballots ranking this candidate in the top slot. */
  readonly firstPlaces: number
  /** rankCounts[i] = ballots placing this candidate in slot i + 1, one entry per active slot. */
  readonly rankCounts: readonly number[]
  /** Sum of statutory slot points over all ballots; unranked earns 0. */
  readonly points: number
}

export interface ContestStatistics {
  /** Valid ballots, the base of the majority rule: rankings plus "Nein" votes. */
  readonly validBallots: number
  /** "Nein" votes; only a single-candidate contest offers them. */
  readonly noBallots: number
  /** Deliberate blank ballots: invalid votes, not part of the majority base. */
  readonly blankBallots: number
  /** One entry per candidate, in the contest's candidate order. */
  readonly candidates: readonly CandidateStatistics[]
}

export function computeStatistics(contest: Contest, ballots: readonly CastBallot[]): ContestStatistics {
  const slots = contestSlots(contest)
  const key = contestKey(contest)
  const counts = new Map<string, number[]>(
    contest.candidateIds.map((id) => [id, Array.from({ length: slots.length }, () => 0)]),
  )

  let noBallots = 0
  let blankBallots = 0
  for (const ballot of ballots) {
    // A CastBallot of another contest would still type-check, and with
    // overlapping ids it could even fit; refuse it rather than count it
    // under the wrong ruleset or into the wrong contest.
    if (!isBallotFor(ballot, key)) {
      throw new TypeError('ballot was validated for a different contest')
    }
    if (ballot.kind === 'blank') {
      blankBallots++
      continue
    }
    if (ballot.kind === 'no') {
      noBallots++
      continue
    }
    ballot.ranking.forEach((id, slot) => {
      const row = counts.get(id)
      // Unreachable for a bound ballot; keeps the lookup total.
      if (row === undefined) throw new TypeError('ballot names a candidate outside the contest')
      row[slot] = (row[slot] ?? 0) + 1
    })
  }

  return {
    validBallots: ballots.length - blankBallots,
    noBallots,
    blankBallots,
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
