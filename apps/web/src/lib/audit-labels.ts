// The audit log in German: one sentence per event from its action and
// its metadata, with ids turned into names where the page knows them.
// Free of the DOM. An action this version does not know is shown by its
// key with its metadata rather than hidden: the log is complete or it is
// nothing.

import type { OutcomeKind, RoundKind, RulesetId } from '@school-election/election-core'
import { ROLE_LABELS, ROUND_LABELS, RULESET_LABELS, type Role } from './labels.ts'

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
const ruleset = (metadata: Metadata): string => RULESET_LABELS[text(metadata, 'rulesetId') as RulesetId] ?? text(metadata, 'rulesetId')
const person = (metadata: Metadata): string => `${text(metadata, 'givenName')} ${text(metadata, 'surname')}`.trim()
const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/** The sentence of every action this version knows, from the event's metadata. */
const SENTENCES: Readonly<Record<string, (metadata: Metadata, names: AuditNames) => string>> = {
  'election.created': (metadata) => `Wahl „${text(metadata, 'title')}“ angelegt.`,
  'election.updated': (metadata) => {
    const description = text(metadata, 'description')
    const quoted = description === '' ? 'keine' : `„${description}“`
    return `Titel und Beschreibung geändert: „${text(metadata, 'title')}“; Beschreibung: ${quoted}.`
  },
  'member.invited': (metadata) => `${text(metadata, 'email')} als ${role(metadata)} eingeladen.`,
  'member.bound': (metadata) => `${text(metadata, 'email')} hat sich angemeldet (${role(metadata)}).`,
  'member.removed': (metadata) => `${text(metadata, 'email')} (${role(metadata)}) entfernt.`,
  'contest.created': (metadata) => `Wahlgang „${text(metadata, 'title')}“ angelegt: ${ruleset(metadata)}.`,
  'contest.updated': (metadata) => `Wahlgang „${text(metadata, 'title')}“ geändert: ${ruleset(metadata)}.`,
  'contest.removed': (metadata) => `Wahlgang „${text(metadata, 'title')}“ entfernt, mit ${plural(num(metadata, 'candidates'), 'Kandidat:in', 'Kandidat:innen')}.`,
  'candidate.added': (metadata, names) => `${person(metadata)} zu „${names.contest(text(metadata, 'contest'))}“ hinzugefügt.`,
  'candidate.renamed': (metadata) => `Kandidat:in umbenannt in ${person(metadata)}.`,
  'candidate.removed': (metadata) => `${person(metadata)} entfernt.`,
  'candidate.picture-set': (metadata, names) => `Foto von ${names.candidate(text(metadata, 'candidate'))} gesetzt.`,
  'candidate.picture-removed': (metadata, names) => `Foto von ${names.candidate(text(metadata, 'candidate'))} entfernt.`,
  'voter-group.created': (metadata) => `Klasse oder Gruppe „${text(metadata, 'name')}“ angelegt.`,
  'voter-group.renamed': (metadata) => `Klasse oder Gruppe umbenannt in „${text(metadata, 'name')}“.`,
  'voter-group.removed': (metadata) => `Klasse oder Gruppe „${text(metadata, 'name')}“ entfernt.`,
  'voter-group.contest-added': (metadata, names) => `„${names.group(text(metadata, 'group'))}“ wählt nun in „${names.contest(text(metadata, 'contest'))}“.`,
  'voter-group.contest-removed': (metadata, names) => `„${names.group(text(metadata, 'group'))}“ wählt nicht mehr in „${names.contest(text(metadata, 'contest'))}“.`,
  'election.prepared': (metadata) => `Wahl vorbereitet: ${plural(num(metadata, 'contests'), 'Wahlgang', 'Wahlgänge')}, ${plural(num(metadata, 'voterGroups'), 'Klasse oder Gruppe', 'Klassen oder Gruppen')}, ${plural(num(metadata, 'candidates'), 'Kandidat:in', 'Kandidat:innen')}.`,
  'election.unprepared': () => 'Zurück zum Entwurf.',
  'credential-batch.issued': (metadata, names) => `${plural(num(metadata, 'keys'), 'Stimmkarte', 'Stimmkarten')} (${round(metadata)}) für „${names.group(text(metadata, 'group'))}“ erzeugt.`,
  'credential-batch.replaced': (metadata, names) => `Stapel für „${names.group(text(metadata, 'group'))}“ (${round(metadata)}) ersetzt: ${plural(num(metadata, 'keys'), 'neue Stimmkarte', 'neue Stimmkarten')}, die alten ungültig.`,
  'credential-batch.voided': (metadata, names) => `${plural(num(metadata, 'keys'), 'Stimmkarte', 'Stimmkarten')} für „${names.group(text(metadata, 'group'))}“ ungültig gemacht.`,
  'test.started': () => 'Probelauf gestartet.',
  'test.ended': (metadata) => `Probelauf beendet: ${plural(num(metadata, 'ballots'), 'Stimme', 'Stimmen')} entfernt, ${plural(num(metadata, 'keys'), 'Code', 'Codes')} wieder frei.`,
  'round.opened': (metadata) => `${round(metadata)} geöffnet.`,
  'round.closed': (metadata) => `${round(metadata)} geschlossen und versiegelt: ${plural(num(metadata, 'ballots'), 'Stimme', 'Stimmen')}.`,
  'result.computed': (metadata, names) => `Ergebnis ausgezählt: „${names.contest(text(metadata, 'contest'))}“, ${round(metadata)}, ${plural(num(metadata, 'ballots'), 'Stimme', 'Stimmen')}: ${outcome(metadata)}. Prüfsumme der Auszählung: ${text(metadata, 'inputSha256')}.`,
  'lot.recorded': (metadata, names) => `Losentscheid für „${names.contest(text(metadata, 'contest'))}“ eingetragen: ${text(metadata, 'order').split(',').map(names.candidate).join(', ')}. Begründung: ${text(metadata, 'reason')}`,
  'runoff.pair': (metadata, names) => `Stichwahl in „${names.contest(text(metadata, 'contest'))}“: ${names.candidate(text(metadata, 'first'))} gegen ${names.candidate(text(metadata, 'second'))}.`,
  'runoff.activated': (metadata) => `Stichwahl gestartet: ${plural(num(metadata, 'contests'), 'Wahlgang', 'Wahlgänge')}, ${plural(num(metadata, 'keys'), 'Stichwahl-Stimmkarte', 'Stichwahl-Stimmkarten')}.`,
  'election.finalized': (metadata) => `Wahl abgeschlossen: ${num(metadata, 'resolved')} entschieden, ${num(metadata, 'unresolved')} offen. Begründung: ${text(metadata, 'reason')}`,
  'export.generated': (metadata) => `Export erzeugt: ${num(metadata, 'bytes')} Bytes, SHA-256 ${text(metadata, 'sha256')}.`,
}

/** The sentence for one event: the action's, or, for an action this version does not know, its key with its metadata. */
export function eventText(action: string, metadata: Metadata, names: AuditNames): string {
  const sentence = SENTENCES[action]
  if (sentence) return sentence(metadata, names)
  const pairs = Object.entries(metadata).map(([key, value]) => `${key} = ${String(value)}`).join(', ')
  return `${action}: ${pairs || 'ohne Angaben'}`
}

/** Every action this version knows a sentence for. */
export const KNOWN_ACTIONS: readonly string[] = Object.keys(SENTENCES)
