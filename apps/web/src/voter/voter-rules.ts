// The voter page's words and the rules it applies before anything is sent:
// the code checked as its check symbol allows, the rows of a ballot from
// the contest's ruleset and its number of candidates, and the sentence for
// every answer of the voter API. Free of the DOM, so node:test checks them.

import { activeSlots, formatKey, normalizeKey, offersNo, parseKey, RULESETS, type Contest, type KeyProblem } from '@school-election/election-core'
import { VoterError, type VoterCandidate, type VoterContest } from './voter-api.ts'

/** What is wrong with a code as typed, before it is sent: the API would say the same. */
export const KEY_HINTS: Readonly<Record<KeyProblem, string>> = {
  length: 'Der Code hat 20 Zeichen. Bitte vergleichen Sie Ihre Eingabe mit der Stimmkarte.',
  symbol: 'Ein Zeichen passt nicht: Ein Code besteht aus Ziffern und Großbuchstaben ohne I, L, O und U.',
  check: 'Da ist ein Tippfehler. Bitte vergleichen Sie Ihre Eingabe mit der Stimmkarte.',
}

/** The problem with what was typed, as a sentence, or null for a well-formed code. */
export function keyHint(input: string): string | null {
  const parsed = parseKey(input)
  return parsed.ok ? null : KEY_HINTS[parsed.problem]
}

/** What was typed, as the card shows it: upper case, O as 0, in groups of four. */
export function groupedKey(input: string): string {
  return formatKey(normalizeKey(input))
}

export const GENERAL_MESSAGE = 'Das hat nicht geklappt. Bitte versuchen Sie es noch einmal.'

/** A sentence for every refusal of the voter API, by its code. */
export const VOTER_MESSAGES: Readonly<Record<string, string>> = {
  unknown_key: 'Diesen Code gibt es nicht. Bitte vergleichen Sie Ihre Eingabe mit der Stimmkarte.',
  invalid_key: KEY_HINTS.check,
  round_planned: 'Die Stimmabgabe hat noch nicht begonnen. Bitte versuchen Sie es später noch einmal.',
  round_closed: 'Die Stimmabgabe ist beendet. Es können keine Stimmen mehr abgegeben werden.',
  rate_limited: 'Zu viele Versuche. Bitte warten Sie einen Moment und versuchen Sie es dann noch einmal.',
  no_session: 'Ihre Zeit ist abgelaufen. Bitte geben Sie den Code noch einmal ein.',
  already_voted: 'In dieser Wahl wurde mit diesem Code schon abgestimmt.',
  not_entitled: 'Mit diesem Code kann in dieser Wahl nicht abgestimmt werden.',
  invalid_ballot: 'Der Stimmzettel wurde nicht angenommen. Bitte prüfen Sie Ihre Auswahl noch einmal.',
  cross_site_request: 'Die Anfrage kam nicht von dieser Seite. Bitte öffnen Sie die Seite neu.',
  internal_error: GENERAL_MESSAGE,
  request_failed: GENERAL_MESSAGE,
}

/** The sentence for an error: a refused code by its problem, any other refusal by its code, anything else the general one. */
export function messageFor(error: unknown): string {
  if (!(error instanceof VoterError)) return GENERAL_MESSAGE
  if (error.code === 'invalid_key' && isKeyProblem(error.problem)) return KEY_HINTS[error.problem]
  return VOTER_MESSAGES[error.code] ?? GENERAL_MESSAGE
}

function isKeyProblem(value: unknown): value is KeyProblem {
  return value === 'length' || value === 'symbol' || value === 'check'
}

export interface SlotRow {
  /** 1-based from the top. */
  rank: number
  points: number
  /** The function the row fills, as the ruleset names it. */
  label: string
}

/** The contest as election-core sees it. */
export function coreContest(contest: Pick<VoterContest, 'id' | 'rulesetId' | 'candidates'>): Contest {
  return { id: contest.id, rulesetId: contest.rulesetId, candidateIds: contest.candidates.map((candidate) => candidate.id) }
}

/** The rows of the contest's ballot: the active slots, which depend on the number of candidates, each with its points and function. */
export function slotRows(contest: Pick<VoterContest, 'rulesetId' | 'candidates'>): SlotRow[] {
  return activeSlots(RULESETS[contest.rulesetId], contest.candidates.length)
    .map((slot) => ({ rank: slot.rank, points: slot.points, label: slot.label }))
}

/** Whether the ballot is "Ja" or "Nein": only with a single candidate. */
export function yesOrNo(contest: Pick<VoterContest, 'id' | 'rulesetId' | 'candidates'>): boolean {
  return offersNo(coreContest(contest))
}

export function pointsLabel(points: number): string {
  return points === 1 ? '1 Punkt' : `${points} Punkte`
}

export function candidateName(candidate: Pick<VoterCandidate, 'surname' | 'givenName'>): string {
  return `${candidate.givenName} ${candidate.surname}`.trim()
}

/** "Noch 2 Wahlen offen.", "Noch 1 Wahl offen.", or that everything is cast. */
export function remainingText(remaining: number): string {
  if (remaining === 0) return 'Sie haben in allen Wahlen abgestimmt.'
  return remaining === 1 ? 'Noch 1 Wahl offen.' : `Noch ${remaining} Wahlen offen.`
}

/** "1 von 2 Zeilen ist leer", "2 von 3 Zeilen sind leer". */
export function emptyRowsText(empty: number, of: number): string {
  return `${empty} von ${of} Zeilen ${empty === 1 ? 'ist' : 'sind'} leer`
}
