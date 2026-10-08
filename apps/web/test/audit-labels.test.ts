import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventText, KNOWN_ACTIONS } from '../src/lib/audit-labels.ts'

const NAMES = {
  contest: (id: string) => `Wahl ${id}`,
  candidate: (id: string) => `Person ${id}`,
  group: (id: string) => `Klasse ${id}`,
}

test('every known action has a sentence that names what its metadata carries, and an unknown one shows its key and metadata', () => {
  const samples: Record<string, Record<string, string | number>> = {
    'election.created': { title: 'Schulsprecherwahl' },
    'election.updated': { title: 'Neu', description: 'x' },
    'member.invited': { email: 'w@schule.example.org', role: 'witness' },
    'member.bound': { email: 'w@schule.example.org', role: 'witness' },
    'member.removed': { email: 'w@schule.example.org', role: 'admin' },
    'contest.created': { contest: 'c1', title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1' },
    'contest.updated': { contest: 'c1', title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1' },
    'contest.removed': { contest: 'c1', title: 'Abstimmung', candidates: 1 },
    'candidate.added': { contest: 'c1', candidate: 'k1', surname: 'Berger', givenName: 'Paula' },
    'candidate.renamed': { candidate: 'k1', surname: 'Huber-Mayer', givenName: 'Quirin' },
    'candidate.removed': { candidate: 'k1', surname: 'Wagner', givenName: 'Renate' },
    'candidate.picture-set': { candidate: 'k1', sha256: 'abc' },
    'candidate.picture-removed': { candidate: 'k1' },
    'voter-group.created': { group: 'g1', name: '1A' },
    'voter-group.renamed': { group: 'g1', name: '1B' },
    'voter-group.removed': { group: 'g1', name: '1A' },
    'voter-group.contest-added': { group: 'g1', contest: 'c1' },
    'voter-group.contest-removed': { group: 'g1', contest: 'c1' },
    'election.prepared': { contests: 2, voterGroups: 1, candidates: 5 },
    'election.unprepared': {},
    'credential-batch.issued': { batch: 'b1', group: 'g1', round: 'regular', keys: 25 },
    'credential-batch.replaced': { batch: 'b1', replacement: 'b2', group: 'g1', round: 'runoff', keys: 1 },
    'credential-batch.voided': { batch: 'b1', group: 'g1', keys: 20 },
    'test.started': { round: 'regular' },
    'test.ended': { round: 'regular', ballots: 3, keys: 2 },
    'round.opened': { round: 'regular' },
    'round.closed': { round: 'runoff', ballots: 3 },
    'result.computed': { contest: 'c1', round: 'regular', inputSha256: 'ff', ballots: 4, outcome: 'lot-required' },
    'lot.recorded': { contest: 'c1', lotId: 'runoff-entry', candidates: 'k1,k2', order: 'k2,k1', reason: 'Los gezogen' },
    'runoff.pair': { contest: 'c1', first: 'k1', second: 'k2' },
    'runoff.activated': { round: 'runoff', contests: 1, keys: 10 },
    'election.finalized': { reason: 'Ergebnis festgestellt', resolved: 2, unresolved: 0 },
    'export.generated': { sha256: 'ab', bytes: 1234 },
  }
  assert.deepEqual(Object.keys(samples).sort(), [...KNOWN_ACTIONS].sort())
  for (const action of KNOWN_ACTIONS) {
    const sentence = eventText(action, samples[action] ?? {}, NAMES)
    assert.ok(sentence.length > 0 && !sentence.includes('undefined') && !sentence.includes('NaN'), `${action}: ${sentence}`)
  }
  assert.equal(eventText('member.invited', samples['member.invited'] ?? {}, NAMES), 'w@schule.example.org als Zeug:in eingeladen.')
  assert.equal(eventText('election.updated', samples['election.updated'] ?? {}, NAMES), 'Titel und Beschreibung geändert: „Neu“; Beschreibung: „x“.', 'a change of the description alone is readable')
  assert.equal(eventText('election.updated', { title: 'Neu', description: '' }, NAMES), 'Titel und Beschreibung geändert: „Neu“; Beschreibung: keine.')
  assert.equal(eventText('candidate.added', samples['candidate.added'] ?? {}, NAMES), 'Paula Berger zu „Wahl c1“ hinzugefügt.')
  assert.equal(eventText('contest.updated', samples['contest.updated'] ?? {}, NAMES), 'Wahl „Schulsprecher/in“ geändert: Schulsprecherwahl: sechs Reihungen, 6 bis 1 Punkt.', 'a change of the rules is readable')
  assert.equal(eventText('election.prepared', samples['election.prepared'] ?? {}, NAMES), 'Wahltermin vorbereitet: 2 Wahlen, 1 Klasse oder Gruppe, 5 Kandidat:innen.')
  assert.equal(eventText('credential-batch.replaced', samples['credential-batch.replaced'] ?? {}, NAMES), 'Stapel für „Klasse g1“ (Stichwahl) ersetzt: 1 neue Stimmkarte, die alten ungültig.')
  assert.equal(eventText('result.computed', samples['result.computed'] ?? {}, NAMES), 'Ergebnis ausgezählt: „Wahl c1“, 1. Wahlgang, 4 Stimmen: Losentscheid erforderlich. Prüfsumme der Auszählung: ff.')
  assert.equal(eventText('lot.recorded', samples['lot.recorded'] ?? {}, NAMES), 'Losentscheid für „Wahl c1“ eingetragen: Person k2, Person k1. Begründung: Los gezogen')
  assert.equal(eventText('election.finalized', samples['election.finalized'] ?? {}, NAMES), 'Ergebnis festgestellt: 2 entschieden, 0 offen. Begründung: Ergebnis festgestellt')
  assert.equal(eventText('something.new', { count: 3, what: 'x' }, NAMES), 'something.new: count = 3, what = x')
  assert.equal(eventText('something.new', {}, NAMES), 'something.new: ohne Angaben')
})
