// The German words for an outcome as it stands, for the Wahltag section's
// short result: what the count decided, who holds which position and on
// what basis, what a lot is for, and the counts of a round. Free of the
// DOM; the full derivation with every step is the result page's. Ids
// become names through the names the caller passes.

import { RULESETS, type CommitteeReason, type ContestStatistics, type LotRequest, type Outcome, type Position, type RulesetId } from '@school-election/election-core'

export interface Names {
  candidate: (id: string) => string
}

/** The ruleset's German label of a function; the key itself where the ruleset has none. */
export function functionLabel(rulesetId: RulesetId, fn: string): string {
  return RULESETS[rulesetId].slots.find((slot) => slot.function === fn)?.label ?? fn
}

const BASIS: Readonly<Record<Position['basis'], string>> = {
  'majority': 'absolute Mehrheit',
  'runoff': 'Stichwahl',
  'points': 'nach Punkten',
  'lot': 'durch Los',
  'votes': 'die meisten Stimmen',
  'lot-pending': 'wartet auf das Los',
  'vacant': 'unbesetzt',
}

/** "A und B", "A, B und C". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} und ${names.at(-1) ?? ''}`
}

/** A position in its parts: the function's label, who holds it (null while vacant or waiting for the lot), on what basis, and whether nobody will. */
export interface PositionParts {
  label: string
  candidateId: string | null
  name: string | null
  basis: string
  vacant: boolean
}

export function positionParts(rulesetId: RulesetId, position: Position, names: Names): PositionParts {
  const label = functionLabel(rulesetId, position.function)
  if (position.candidateId === null) {
    const pending = position.basis === 'lot-pending'
    return { label, candidateId: null, name: null, basis: BASIS[pending ? 'lot-pending' : 'vacant'], vacant: !pending }
  }
  return { label, candidateId: position.candidateId, name: names.candidate(position.candidateId), basis: BASIS[position.basis], vacant: false }
}

export function positionLine(rulesetId: RulesetId, position: Position, names: Names): string {
  const parts = positionParts(rulesetId, position, names)
  return parts.name === null ? `${parts.label}: ${parts.basis}` : `${parts.label}: ${parts.name} (${parts.basis})`
}

/** The positions an outcome has, in parts: as positionLines, for a page that lays them out. */
export function positionsOf(rulesetId: RulesetId, outcome: Outcome, names: Names): PositionParts[] {
  if (outcome.kind !== 'final' && outcome.kind !== 'lot-required') return []
  return outcome.positions.map((position) => positionParts(rulesetId, position, names))
}

/**
 * Labels of positions in one phrase: "1., 2. und 3. Stellvertretung im SGA"
 * where they differ only in their number, else listed as they are.
 */
export function joinedLabels(labels: readonly string[]): string {
  const parts = labels.map((label) => /^(\d+\.) (.+)$/.exec(label))
  const rest = parts[0]?.[2]
  if (labels.length > 1 && parts.every((part) => part !== null && part[2] === rest)) {
    return `${listed(parts.map((part) => part?.[1] ?? ''))} ${rest ?? ''}`
  }
  return listed(labels)
}

/** The positions an outcome has: every one of a final outcome, and the ones a lot-required outcome has decided so far. */
export function positionLines(rulesetId: RulesetId, outcome: Outcome, names: Names): string[] {
  if (outcome.kind !== 'final' && outcome.kind !== 'lot-required') return []
  return outcome.positions.map((position) => positionLine(rulesetId, position, names))
}

export function committeeText(reason: CommitteeReason): string {
  switch (reason) {
    case 'no-valid-ballots':
      return 'Keine gültige Stimme: die Wahlkommission entscheidet.'
    case 'single-candidate-not-elected':
      return 'Nicht gewählt: „Nein“ hatte mindestens so viele Stimmen wie „Ja“. Die Wahlkommission entscheidet.'
  }
}

/** What the count decided, in one sentence. */
export function outcomeLine(outcome: Outcome, names: Names): string {
  switch (outcome.kind) {
    case 'final':
      return 'Gewählt.'
    case 'runoff-required':
      return `Stichwahl zwischen ${names.candidate(outcome.runoffCandidates[0])} und ${names.candidate(outcome.runoffCandidates[1])}.`
    case 'lot-required':
      return outcome.lots.length === 1 ? 'Losentscheid erforderlich.' : `${outcome.lots.length} Losentscheide erforderlich.`
    case 'tie':
      return `Unentschieden zwischen ${listed(outcome.candidates.map(names.candidate))}: die Wahlkommission entscheidet.`
    case 'committee-decision':
      return committeeText(outcome.reason)
  }
}

/** What a lot is for: who is tied and what the draw decides. */
export function lotText(rulesetId: RulesetId, lot: LotRequest, names: Names): string {
  const tied = listed(lot.candidates.map(names.candidate))
  if (lot.reason === 'runoff-entry') {
    const places = lot.seats === 1 ? 'ein Platz' : `${lot.seats} Plätze`
    const sentence = `${tied} sind gleichauf; das Los entscheidet, wer von ihnen in die Stichwahl kommt (${places}).`
    if (lot.qualified.length === 0) return sentence
    return `${sentence} Bereits in der Stichwahl: ${listed(lot.qualified.map(names.candidate))}.`
  }
  return `${tied} sind gleichauf; das Los entscheidet die Reihenfolge für: ${lot.positions.map((fn) => functionLabel(rulesetId, fn)).join(', ')}.`
}

/** The ballots of a round: cast, and of them "Nein" and invalid where there were any. */
export function countsLine(statistics: ContestStatistics): string {
  const cast = statistics.validBallots + statistics.invalidBallots
  const parts = [cast === 1 ? '1 Stimme' : `${cast} Stimmen`]
  if (statistics.noBallots > 0) parts.push(`davon ${statistics.noBallots} „Nein“`)
  if (statistics.invalidBallots > 0) parts.push(`davon ${statistics.invalidBallots} ungültig`)
  return `${parts.join(', ')}.`
}

/**
 * The first places of a ranked contest, or the votes of a single choice,
 * highest first, in one sentence; nothing without a valid ballot.
 */
export function firstPlacesLine(rulesetId: RulesetId, statistics: ContestStatistics, names: Names): string {
  if (statistics.validBallots === 0 || statistics.candidates.length === 0) return ''
  const label = rulesetId === 'single-choice-v1' ? 'Stimmen' : 'Erste Stellen'
  const sorted = statistics.candidates.toSorted((a, b) => b.firstPlaces - a.firstPlaces)
  const figures = sorted.map((candidate) => `${names.candidate(candidate.candidateId)} ${candidate.firstPlaces}`).join(', ')
  return `${label}: ${figures}.`
}

/** The first places of a ranked contest, or the votes of a single choice, highest first, in figures for bars; no rows without a valid ballot. */
export function firstPlaceFigures(rulesetId: RulesetId, statistics: ContestStatistics): { label: string, rows: { candidateId: string, figure: number }[] } {
  const label = rulesetId === 'single-choice-v1' ? 'Stimmen' : 'Erste Stellen'
  if (statistics.validBallots === 0) return { label, rows: [] }
  const rows = statistics.candidates.toSorted((a, b) => b.firstPlaces - a.firstPlaces).map((candidate) => ({ candidateId: candidate.candidateId, figure: candidate.firstPlaces }))
  return { label, rows }
}

/** A recorded lot, as the section lists it. */
export function recordedLotLine(drawn: readonly string[], actorName: string, at: string, reason: string, names: Names): string {
  return `Los eingetragen von ${actorName} am ${dateTime(at)}: ${drawn.map(names.candidate).join(', ')}. Begründung: ${reason}`
}

/** A moment as the pages write it: "5.10.2026, 14:12". */
export function dateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('de-AT', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
