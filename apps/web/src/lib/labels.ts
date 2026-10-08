// The German words for what the API names by its codes: states, roles,
// rulesets, round kinds, and what preparing reports. Free of the DOM, so
// node:test can check that every code has its word.
//
// The glossary: an election in the API is a Wahltermin, the date with
// everything voted on it; a contest is a Wahl ("Schulsprecher/in"), a
// poll's too, whose preset titles it "Abstimmung" (its ruleset alone does
// not tell a poll from an election with one vote each); a round is a
// Wahlgang, the 1. Wahlgang or the Stichwahl. Closing a round ends its Stimmabgabe and counts it;
// finalizing establishes the Ergebnis for good. Functions are written with
// a slash as on the ballot (Schulsprecher/in), other people with a colon
// (Kandidat:innen, Zeug:innen).

import type { ElectionState, Lifecycle, RoundKind, RulesetId } from '@school-election/election-core'

/** A Wahltermin's state as a list names it, where only the termin's own state is known. */
export const STATE_LABELS: Readonly<Record<ElectionState, string>> = {
  draft: 'Entwurf',
  prepared: 'Vorbereitet',
  active: 'Stimmabgabe begonnen',
  final: 'Abgeschlossen',
}

/** A Wahltermin's state with its rounds, as its page names it: which Wahlgang runs, or is counted. */
export function stateLabel(lifecycle: Lifecycle): string {
  switch (lifecycle.election) {
    case 'draft':
    case 'final':
      return STATE_LABELS[lifecycle.election]
    case 'prepared':
      return lifecycle.regular === 'testing' ? 'Probelauf' : STATE_LABELS.prepared
    case 'active':
      if (lifecycle.runoff !== null) return lifecycle.runoff === 'open' ? 'Stichwahl läuft' : 'Stichwahl ausgezählt'
      return lifecycle.regular === 'open' ? '1. Wahlgang läuft' : '1. Wahlgang ausgezählt'
  }
}

export type Role = 'owner' | 'admin' | 'witness'

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  owner: 'Wahlleitung',
  admin: 'Co-Admin',
  witness: 'Zeug:in',
}

/** What an invited member may do, said where they are invited. */
export const ROLE_DESCRIPTIONS: Readonly<Record<Exclude<Role, 'owner'>, string>> = {
  admin: 'Richtet ein, lädt Zeug:innen ein und führt durch den Wahltag; das Ergebnis stellt nur die Wahlleitung fest.',
  witness: 'Sieht alles, ändert nichts; die Stimmkarten erst, wenn ihr Wahlgang beendet ist.',
}

export const RULESET_LABELS: Readonly<Record<RulesetId, string>> = {
  'at-school-speaker-v1': 'Schulsprecherwahl: sechs Reihungen, 6 bis 1 Punkt',
  'at-representative-v1': 'Vertretung und Stellvertretung: zwei Reihungen, 2 und 1 Punkt',
  'single-choice-v1': 'Eine Stimme',
}

/** A round as a Wahlgang: on the cards, in the turnout, in the log. */
export const ROUND_LABELS: Readonly<Record<RoundKind, string>> = {
  regular: '1. Wahlgang',
  runoff: 'Stichwahl',
}

export const MEMBER_STATUS_LABELS = {
  pending: 'eingeladen, noch nicht angemeldet',
  bound: 'angemeldet',
} as const

/** What blocks preparing, as the API reports it (apps/api/lib/prepare.ts). */
export type Problem
  = | { kind: 'no-contests' }
    | { kind: 'no-voter-groups' }
    | { kind: 'contest-without-candidates', contestId: string }
    | { kind: 'contest-without-voter-groups', contestId: string }
    | { kind: 'voter-group-without-contests', voterGroupId: string }

export type Warning
  = | { kind: 'no-co-admin' }
    | { kind: 'too-few-witnesses', witnesses: number }
    | { kind: 'pending-invitations', count: number }

/** The names the message needs: contests by id and groups by id. */
export interface Names {
  contest: (id: string) => string
  group: (id: string) => string
}

export function problemText(problem: Problem, names: Names): string {
  switch (problem.kind) {
    case 'no-contests':
      return 'Der Wahltermin hat noch keine Wahl.'
    case 'no-voter-groups':
      return 'Der Wahltermin hat noch keine Klassen oder Gruppen.'
    case 'contest-without-candidates':
      return `Die Wahl „${names.contest(problem.contestId)}“ hat noch keine Kandidat:innen.`
    case 'contest-without-voter-groups':
      return `In der Wahl „${names.contest(problem.contestId)}“ wählt noch keine Klasse oder Gruppe.`
    case 'voter-group-without-contests':
      return `Die Klasse oder Gruppe „${names.group(problem.voterGroupId)}“ wählt in keiner Wahl.`
  }
}

export function warningText(warning: Warning): string {
  switch (warning.kind) {
    case 'no-co-admin':
      return 'Als Co-Admin hat sich noch niemand angemeldet.'
    case 'too-few-witnesses':
      return warning.witnesses === 0
        ? 'Als Zeug:in hat sich noch niemand angemeldet; üblich sind zwei.'
        : 'Als Zeug:in hat sich erst eine Person angemeldet; üblich sind zwei.'
    case 'pending-invitations':
      return warning.count === 1
        ? 'Eine Einladung ist noch offen: die Person hat sich noch nicht angemeldet.'
        : `${warning.count} Einladungen sind noch offen: diese Personen haben sich noch nicht angemeldet.`
  }
}

/** The first sentence of a section's hint on why nothing can be changed now. */
export function lockedText(state: ElectionState): string {
  switch (state) {
    case 'draft':
      return ''
    case 'prepared':
      return 'Der Wahltermin ist vorbereitet: Aufbau und Zuordnung sind festgelegt. Für Änderungen daran zurück zum Entwurf.'
    case 'active':
      return 'Die Stimmabgabe hat begonnen: Kandidat:innen und die Stimmkarten des 1. Wahlgangs sind festgelegt.'
    case 'final':
      return 'Das Ergebnis ist festgestellt: nichts ändert sich mehr.'
  }
}
