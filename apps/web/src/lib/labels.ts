// The German words for what the API names by its codes: states, roles,
// rulesets, round kinds, and what preparing reports. Free of the DOM, so
// node:test can check that every code has its word.

import type { ElectionState, RoundKind, RulesetId } from '@school-election/election-core'

export const STATE_LABELS: Readonly<Record<ElectionState, string>> = {
  draft: 'Entwurf',
  prepared: 'Vorbereitet',
  active: 'Wahl läuft',
  final: 'Abgeschlossen',
}

export type Role = 'owner' | 'admin' | 'witness'

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  owner: 'Wahlleitung',
  admin: 'Co-Admin',
  witness: 'Zeugin/Zeuge',
}

export const RULESET_LABELS: Readonly<Record<RulesetId, string>> = {
  'at-school-speaker-v1': 'Schulsprecherwahl: sechs Reihungen, 6 bis 1 Punkt',
  'at-representative-v1': 'Vertretung und Stellvertretung: zwei Reihungen, 2 und 1 Punkt',
  'single-choice-v1': 'Eine Stimme',
}

export const ROUND_LABELS: Readonly<Record<RoundKind, string>> = {
  regular: 'Wahl',
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
      return 'Die Wahl hat noch keine Wahlgänge.'
    case 'no-voter-groups':
      return 'Die Wahl hat noch keine Klassen oder Gruppen.'
    case 'contest-without-candidates':
      return `Der Wahlgang „${names.contest(problem.contestId)}“ hat noch keine Kandidat:innen.`
    case 'contest-without-voter-groups':
      return `Im Wahlgang „${names.contest(problem.contestId)}“ wählt noch keine Klasse oder Gruppe.`
    case 'voter-group-without-contests':
      return `Die Klasse oder Gruppe „${names.group(problem.voterGroupId)}“ wählt in keinem Wahlgang.`
  }
}

export function warningText(warning: Warning): string {
  switch (warning.kind) {
    case 'no-co-admin':
      return 'Es gibt noch keinen Co-Admin, der sich angemeldet hat.'
    case 'too-few-witnesses':
      return warning.witnesses === 0
        ? 'Es hat sich noch keine Zeugin und kein Zeuge angemeldet; üblich sind zwei.'
        : 'Es hat sich erst eine Zeugin oder ein Zeuge angemeldet; üblich sind zwei.'
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
      return 'Die Wahl ist vorbereitet: Aufbau und Zuordnung sind festgelegt. Für Änderungen daran zurück zum Entwurf.'
    case 'active':
      return 'Die Wahl läuft: Kandidat:innen und Stimmkarten der ersten Runde sind festgelegt.'
    case 'final':
      return 'Die Wahl ist abgeschlossen: nichts ändert sich mehr.'
  }
}
