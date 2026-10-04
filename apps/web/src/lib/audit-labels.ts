// The audit log in German: one sentence per event from its action and
// its metadata, with ids turned into names where the page knows them.
// Free of the DOM. An action this version does not know is shown by its
// key with its metadata rather than hidden: the log is complete or it is
// nothing.

import type { OutcomeKind, RoundKind } from '@school-election/election-core'
import { ROLE_LABELS, ROUND_LABELS, type Role } from './labels.ts'

export interface AuditNames {
  contest: (id: string) => string
  candidate: (id: string) => string
  group: (id: string) => string
}

export type Metadata = Readonly<Record<string, string | number>>

const OUTCOME_LABELS: Readonly<Record<OutcomeKind, string>> = {
  'final': 'entschieden',
  'lot-required': 'Losentscheid erforderlich',
  'runoff-required': 'Stichwahl erforderlich',
  'tie': 'unentschieden',
  'committee-decision': 'die Wahlkommission entscheidet',
}

const text = (metadata: Metadata, key: string): string => String(metadata[key] ?? '')
const num = (metadata: Metadata, key: string): number => Number(metadata[key] ?? 0)
const role = (metadata: Metadata): string => ROLE_LABELS[text(metadata, 'role') as Role] ?? text(metadata, 'role')
const round = (metadata: Metadata): string => ROUND_LABELS[text(metadata, 'round') as RoundKind] ?? text(metadata, 'round')
const outcome = (metadata: Metadata): string => OUTCOME_LABELS[text(metadata, 'outcome') as OutcomeKind] ?? text(metadata, 'outcome')
const person = (metadata: Metadata): string => `${text(metadata, 'givenName')} ${text(metadata, 'surname')}`.trim()
const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/** The sentence for one event. */
export function eventText(action: string, metadata: Metadata, names: AuditNames): string {
  switch (action) {
    case 'election.created':
      return `Wahl „${text(metadata, 'title')}“ angelegt.`
    case 'election.updated':
      return `Titel und Beschreibung geändert: „${text(metadata, 'title')}“.`
    case 'member.invited':
      return `${text(metadata, 'email')} als ${role(metadata)} eingeladen.`
    case 'member.bound':
      return `${text(metadata, 'email')} hat sich angemeldet (${role(metadata)}).`
    case 'member.removed':
      return `${text(metadata, 'email')} (${role(metadata)}) entfernt.`
    case 'contest.created':
      return `Wahlgang „${text(metadata, 'title')}“ angelegt.`
    case 'contest.updated':
      return `Wahlgang „${text(metadata, 'title')}“ geändert.`
    case 'contest.removed':
      return `Wahlgang „${text(metadata, 'title')}“ entfernt, mit ${plural(num(metadata, 'candidates'), 'Kandidat:in', 'Kandidat:innen')}.`
    case 'candidate.added':
      return `${person(metadata)} zu „${names.contest(text(metadata, 'contest'))}“ hinzugefügt.`
    case 'candidate.renamed':
      return `Kandidat:in umbenannt in ${person(metadata)}.`
    case 'candidate.removed':
      return `${person(metadata)} entfernt.`
    case 'candidate.picture-set':
      return `Foto von ${names.candidate(text(metadata, 'candidate'))} gesetzt.`
    case 'candidate.picture-removed':
      return `Foto von ${names.candidate(text(metadata, 'candidate'))} entfernt.`
    case 'voter-group.created':
      return `Klasse oder Gruppe „${text(metadata, 'name')}“ angelegt.`
    case 'voter-group.renamed':
      return `Klasse oder Gruppe umbenannt in „${text(metadata, 'name')}“.`
    case 'voter-group.removed':
      return `Klasse oder Gruppe „${text(metadata, 'name')}“ entfernt.`
    case 'voter-group.contest-added':
      return `„${names.group(text(metadata, 'group'))}“ wählt nun in „${names.contest(text(metadata, 'contest'))}“.`
    case 'voter-group.contest-removed':
      return `„${names.group(text(metadata, 'group'))}“ wählt nicht mehr in „${names.contest(text(metadata, 'contest'))}“.`
    case 'election.prepared':
      return `Wahl vorbereitet: ${plural(num(metadata, 'contests'), 'Wahlgang', 'Wahlgänge')}, ${plural(num(metadata, 'voterGroups'), 'Klasse oder Gruppe', 'Klassen oder Gruppen')}, ${plural(num(metadata, 'candidates'), 'Kandidat:in', 'Kandidat:innen')}.`
    case 'election.unprepared':
      return 'Zurück zum Entwurf.'
    case 'credential-batch.issued':
      return `${plural(num(metadata, 'keys'), 'Stimmkarte', 'Stimmkarten')} (${round(metadata)}) für „${names.group(text(metadata, 'group'))}“ erzeugt.`
    case 'credential-batch.replaced':
      return `Stapel für „${names.group(text(metadata, 'group'))}“ (${round(metadata)}) ersetzt: ${plural(num(metadata, 'keys'), 'neue Stimmkarte', 'neue Stimmkarten')}, die alten ungültig.`
    case 'credential-batch.voided':
      return `${plural(num(metadata, 'keys'), 'Stimmkarte', 'Stimmkarten')} für „${names.group(text(metadata, 'group'))}“ ungültig gemacht.`
    case 'test.started':
      return 'Probelauf gestartet.'
    case 'test.ended':
      return `Probelauf beendet: ${plural(num(metadata, 'ballots'), 'Stimme', 'Stimmen')} entfernt, ${plural(num(metadata, 'keys'), 'Code', 'Codes')} wieder frei.`
    case 'round.opened':
      return `${round(metadata)} geöffnet.`
    case 'round.closed':
      return `${round(metadata)} geschlossen und versiegelt: ${plural(num(metadata, 'ballots'), 'Stimme', 'Stimmen')}.`
    case 'result.computed':
      return `Ergebnis ausgezählt: „${names.contest(text(metadata, 'contest'))}“, ${round(metadata)}, ${plural(num(metadata, 'ballots'), 'Stimme', 'Stimmen')}: ${outcome(metadata)}. Prüfsumme der Auszählung: ${text(metadata, 'inputSha256')}.`
    case 'lot.recorded':
      return `Losentscheid für „${names.contest(text(metadata, 'contest'))}“ eingetragen: ${text(metadata, 'order').split(',').map(names.candidate).join(', ')}. Begründung: ${text(metadata, 'reason')}`
    case 'runoff.pair':
      return `Stichwahl in „${names.contest(text(metadata, 'contest'))}“: ${names.candidate(text(metadata, 'first'))} gegen ${names.candidate(text(metadata, 'second'))}.`
    case 'runoff.activated':
      return `Stichwahl gestartet: ${plural(num(metadata, 'contests'), 'Wahlgang', 'Wahlgänge')}, ${plural(num(metadata, 'keys'), 'Stichwahl-Stimmkarte', 'Stichwahl-Stimmkarten')}.`
    case 'election.finalized':
      return `Wahl abgeschlossen: ${num(metadata, 'resolved')} entschieden, ${num(metadata, 'unresolved')} offen. Begründung: ${text(metadata, 'reason')}`
    case 'export.generated':
      return `Export erzeugt: ${num(metadata, 'bytes')} Bytes, SHA-256 ${text(metadata, 'sha256')}.`
    default:
      return `${action}: ${Object.entries(metadata).map(([key, value]) => `${key} = ${String(value)}`).join(', ') || 'ohne Angaben'}`
  }
}

/** Every action this version knows a sentence for, in the order they were added to the API. */
export const KNOWN_ACTIONS = [
  'election.created', 'election.updated', 'member.invited', 'member.bound', 'member.removed',
  'contest.created', 'contest.updated', 'contest.removed', 'candidate.added', 'candidate.renamed', 'candidate.removed',
  'candidate.picture-set', 'candidate.picture-removed', 'voter-group.created', 'voter-group.renamed', 'voter-group.removed',
  'voter-group.contest-added', 'voter-group.contest-removed', 'election.prepared', 'election.unprepared',
  'credential-batch.issued', 'credential-batch.replaced', 'credential-batch.voided', 'test.started', 'test.ended',
  'round.opened', 'round.closed', 'result.computed', 'lot.recorded', 'runoff.pair', 'runoff.activated',
  'election.finalized', 'export.generated',
] as const
