// The derivation of a result in German, step by step, from election-core's
// trace: the count, the majority rule, every comparison with its figures
// and why someone advances, the runoff, the positions by first-round
// points, the lots required and applied, and the committee's cases. Free
// of the DOM; the result page renders the sentences. A step this version
// does not know is named by its key rather than hidden.

import { activeSlots, RULESETS, type CandidateValue, type ContestStatistics, type RulesetId, type TraceStep } from '@school-election/election-core'
import { committeeText, functionLabel, listed, lotText, type Names } from './outcome-text.ts'

const BASIS: Readonly<Record<'first-places' | 'points' | 'votes', string>> = {
  'first-places': 'ersten Stellen',
  'points': 'Punkten des 1. Wahlgangs',
  'votes': 'Stimmen',
}

const UNIT: Readonly<Record<'first-places' | 'points' | 'votes', string>> = {
  'first-places': 'erste Stellen',
  'points': 'Punkte',
  'votes': 'Stimmen',
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/** "Paula Berger 2, Quirin Huber-Mayer 1": the figures as compared, highest first. */
export function valuesText(values: readonly CandidateValue[], names: Names): string {
  return values.map((value) => `${names.candidate(value.candidateId)} ${value.value}`).join(', ')
}

/** One sentence for a step of the derivation. */
export function stepText(rulesetId: RulesetId, step: TraceStep, names: Names): string {
  switch (step.step) {
    case 'count':
      return countText(step)
    case 'majority': {
      const reached = step.elected === null ? 'Niemand erreicht sie.' : `${names.candidate(step.elected)} erreicht sie.`
      return `Absolute Mehrheit: mindestens ${plural(step.required, 'erste Stelle', 'erste Stellen')} nötig. ${reached}`
    }
    case 'compare':
      return compareText(step, names)
    case 'runoff':
      return `Stichwahl zwischen ${names.candidate(step.candidates[0])} und ${names.candidate(step.candidates[1])}.`
    case 'positions':
      return `Die weiteren Positionen nach den Punkten des 1. Wahlgangs, ohne ${names.candidate(step.excluded)}: ${valuesText(step.values, names) || 'niemand mehr'}.`
    case 'lot-required':
      return `Losentscheid: ${lotText(rulesetId, step.lot, names)}`
    case 'lot-applied':
      return `Los angewendet: ${step.order.map(names.candidate).join(', ')}.`
    case 'committee-decision':
      return committeeText(step.reason)
    default:
      return `Schritt „${String((step as { step: unknown }).step)}“ (von einer neueren Version).`
  }
}

function countText(step: Extract<TraceStep, { step: 'count' }>): string {
  const parts = [`${plural(step.ballotsCast, 'Stimme', 'Stimmen')} abgegeben`, `${step.validBallots} gültig`]
  if (step.noBallots > 0) parts.push(`davon ${step.noBallots} „Nein“`)
  if (step.invalidBallots > 0) parts.push(`${step.invalidBallots} ungültig`)
  return `${parts.join(', ')}.`
}

/**
 * A comparison: the figures, who advances and why (a lower figure named
 * where there is one), and who is tied for the places left.
 */
function compareText(step: Extract<TraceStep, { step: 'compare' }>, names: Names): string {
  const places = plural(step.seats, 'Platz', 'Plätze')
  const sentences = [`Vergleich nach ${BASIS[step.basis]} um ${places}: ${valuesText(step.values, names)}.`]
  if (step.advancing.length > 0) {
    const last = step.values.findLast((value) => step.advancing.includes(value.candidateId))
    const next = step.values.find((value) => !step.advancing.includes(value.candidateId))
    const who = listed(step.advancing.map(names.candidate))
    const verb = step.advancing.length === 1 ? 'kommt weiter' : 'kommen weiter'
    sentences.push(last !== undefined && next !== undefined
      ? `${who} ${verb}, weil ${last.value} > ${next.value} ${UNIT[step.basis]}.`
      : `${who} ${verb}.`)
  }
  if (step.tied.length > 0) sentences.push(`Gleichauf: ${listed(step.tied.map(names.candidate))}.`)
  return sentences.join(' ')
}

export interface StatisticsRow {
  candidateId: string
  name: string
  firstPlaces: number
  /** One count per active slot, in slot order. */
  rankCounts: number[]
  points: number
}

export interface StatisticsTable {
  /** The active slots' headings: "6 Punkte · Schulsprecher/in". */
  slots: string[]
  rows: StatisticsRow[]
  validBallots: number
  noBallots: number
  invalidBallots: number
}

/** The figures of a round as a table: a row per candidate in contest order, a column per active slot. */
export function statisticsTable(rulesetId: RulesetId, statistics: ContestStatistics, names: Names): StatisticsTable {
  const slots = activeSlots(RULESETS[rulesetId], Math.max(1, statistics.candidates.length))
  return {
    slots: slots.map((slot) => `${plural(slot.points, 'Punkt', 'Punkte')} · ${functionLabel(rulesetId, slot.function)}`),
    rows: statistics.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      name: names.candidate(candidate.candidateId),
      firstPlaces: candidate.firstPlaces,
      rankCounts: slots.map((slot, index) => candidate.rankCounts[index] ?? 0),
      points: candidate.points,
    })),
    validBallots: statistics.validBallots,
    noBallots: statistics.noBallots,
    invalidBallots: statistics.invalidBallots,
  }
}
