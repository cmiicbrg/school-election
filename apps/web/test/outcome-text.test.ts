import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ContestStatistics, Outcome } from '@school-election/election-core'
import { fileNameOf } from '../src/lib/download.ts'
import { committeeText, countsLine, dateTime, firstPlacesLine, functionLabel, listed, lotText, outcomeLine, positionLines, recordedLotLine } from '../src/lib/outcome-text.ts'

const NAMES = { candidate: (id: string) => ({ p: 'Paula Berger', q: 'Quirin Huber-Mayer', r: 'Renate Wagner' })[id] ?? id }

test('the positions of a final outcome, each with its basis in words; a pending and a vacant one', () => {
  const outcome: Outcome = {
    kind: 'final',
    positions: [
      { function: 'school-speaker', candidateId: 'r', basis: 'runoff' },
      { function: 'school-speaker-deputy-1', candidateId: 'q', basis: 'lot' },
      { function: 'school-speaker-deputy-2', candidateId: 'p', basis: 'points' },
      { function: 'sga-deputy-1', candidateId: null, basis: 'vacant' },
    ],
    trace: [],
  }
  assert.deepEqual(positionLines('at-school-speaker-v1', outcome, NAMES), [
    'Schulsprecher/in: Renate Wagner (Stichwahl)',
    '1. Stellvertretung Schulsprecher/in: Quirin Huber-Mayer (durch Los)',
    '2. Stellvertretung Schulsprecher/in: Paula Berger (nach Punkten)',
    '1. Stellvertretung im SGA: unbesetzt',
  ])
  const pending: Outcome = { kind: 'lot-required', lots: [], positions: [{ function: 'representative', candidateId: 'p', basis: 'majority' }, { function: 'deputy', candidateId: null, basis: 'lot-pending' }], trace: [] }
  assert.deepEqual(positionLines('at-representative-v1', pending, NAMES), ['Vertreter/in: Paula Berger (absolute Mehrheit)', 'Stellvertreter/in: wartet auf das Los'])
  assert.deepEqual(positionLines('single-choice-v1', { kind: 'final', positions: [{ function: 'choice', candidateId: 'p', basis: 'votes' }], trace: [] }, NAMES), ['Stimme: Paula Berger (die meisten Stimmen)'])
  assert.deepEqual(positionLines('at-school-speaker-v1', { kind: 'runoff-required', runoffCandidates: ['p', 'r'], trace: [] }, NAMES), [])
  assert.equal(functionLabel('at-school-speaker-v1', 'something-new'), 'something-new')
})

test('what the count decided, in one sentence, for every kind', () => {
  assert.equal(outcomeLine({ kind: 'final', positions: [], trace: [] }, NAMES), 'Gewählt.')
  assert.equal(outcomeLine({ kind: 'runoff-required', runoffCandidates: ['p', 'r'], trace: [] }, NAMES), 'Stichwahl zwischen Paula Berger und Renate Wagner.')
  const lot = { id: 'runoff-entry' as const, reason: 'runoff-entry' as const, candidates: ['q', 'r'], seats: 1, qualified: ['p'] }
  assert.equal(outcomeLine({ kind: 'lot-required', lots: [lot], positions: [], trace: [] }, NAMES), 'Losentscheid erforderlich.')
  assert.equal(outcomeLine({ kind: 'lot-required', lots: [lot, lot], positions: [], trace: [] }, NAMES), '2 Losentscheide erforderlich.')
  assert.equal(outcomeLine({ kind: 'tie', candidates: ['p', 'q', 'r'], trace: [] }, NAMES), 'Unentschieden zwischen Paula Berger, Quirin Huber-Mayer und Renate Wagner: die Wahlkommission entscheidet.')
  assert.equal(outcomeLine({ kind: 'committee-decision', reason: 'no-valid-ballots', trace: [] }, NAMES), 'Keine gültige Stimme: die Wahlkommission entscheidet.')
  assert.ok(committeeText('single-candidate-not-elected').startsWith('Nicht gewählt'))
  assert.equal(listed([]), '')
  assert.equal(listed(['A']), 'A')
})

test('what a lot is for: the runoff entry with the seats and who is in already, or the positions in order', () => {
  assert.equal(
    lotText('at-school-speaker-v1', { id: 'runoff-entry', reason: 'runoff-entry', candidates: ['q', 'r'], seats: 1, qualified: ['p'] }, NAMES),
    'Quirin Huber-Mayer und Renate Wagner sind gleichauf; das Los entscheidet, wer von ihnen in die Stichwahl kommt (ein Platz). Bereits in der Stichwahl: Paula Berger.',
  )
  assert.equal(
    lotText('at-school-speaker-v1', { id: 'runoff-entry', reason: 'runoff-entry', candidates: ['p', 'q', 'r'], seats: 2, qualified: [] }, NAMES),
    'Paula Berger, Quirin Huber-Mayer und Renate Wagner sind gleichauf; das Los entscheidet, wer von ihnen in die Stichwahl kommt (2 Plätze).',
  )
  assert.equal(
    lotText('at-school-speaker-v1', { id: 'positions:school-speaker-deputy-1', reason: 'positions', candidates: ['p', 'q'], positions: ['school-speaker-deputy-1', 'school-speaker-deputy-2'] }, NAMES),
    'Paula Berger und Quirin Huber-Mayer sind gleichauf; das Los entscheidet die Reihenfolge für: 1. Stellvertretung Schulsprecher/in, 2. Stellvertretung Schulsprecher/in.',
  )
})

test('the counts of a round and the first places, highest first; the votes of a single choice', () => {
  const statistics: ContestStatistics = {
    validBallots: 4, noBallots: 0, invalidBallots: 1,
    candidates: [{ candidateId: 'p', firstPlaces: 1, rankCounts: [1, 2, 1], points: 20 }, { candidateId: 'q', firstPlaces: 2, rankCounts: [2, 1, 1], points: 20 }, { candidateId: 'r', firstPlaces: 1, rankCounts: [1, 1, 2], points: 20 }],
  }
  assert.equal(countsLine(statistics), '5 Stimmen, davon 1 ungültig.')
  assert.equal(countsLine({ validBallots: 1, noBallots: 1, invalidBallots: 0, candidates: [] }), '1 Stimme, davon 1 „Nein“.')
  assert.equal(firstPlacesLine('at-school-speaker-v1', statistics, NAMES), 'Erste Stellen: Quirin Huber-Mayer 2, Paula Berger 1, Renate Wagner 1.')
  assert.equal(firstPlacesLine('single-choice-v1', { ...statistics, validBallots: 3 }, NAMES), 'Stimmen: Quirin Huber-Mayer 2, Paula Berger 1, Renate Wagner 1.')
  assert.equal(firstPlacesLine('at-school-speaker-v1', { validBallots: 0, noBallots: 0, invalidBallots: 2, candidates: statistics.candidates }, NAMES), '')
})

test('a recorded lot in one line, a moment in German, and the file name of an attachment', () => {
  assert.match(recordedLotLine(['r', 'q'], 'Anna Lehrerin', '2026-10-05T12:12:00.000Z', 'Los gezogen', NAMES), /^Los eingetragen von Anna Lehrerin am \d{1,2}\.\d{1,2}\.2026, \d{2}:\d{2}: Renate Wagner, Quirin Huber-Mayer\. Begründung: Los gezogen$/)
  assert.equal(dateTime('not a date'), 'not a date')
  assert.equal(fileNameOf('attachment; filename="wahl-abc.json"'), 'wahl-abc.json')
  assert.equal(fileNameOf('attachment; filename=wahl.json'), 'wahl.json')
  assert.equal(fileNameOf('attachment; filename="../evil"'), null)
  assert.equal(fileNameOf(null), null)
})
