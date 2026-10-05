import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ContestStatistics, TraceStep } from '@school-election/election-core'
import { statisticsTable, stepText, valuesText } from '../src/lib/trace-text.ts'

const NAMES = { candidate: (id: string) => ({ p: 'Paula Berger', q: 'Quirin Huber-Mayer', r: 'Renate Wagner' })[id] ?? id }
const say = (step: TraceStep) => stepText('at-school-speaker-v1', step, NAMES)

test('every step kind has its sentence, with the figures the step carries', () => {
  assert.equal(say({ step: 'count', contestId: 'c', ballotsCast: 5, validBallots: 4, noBallots: 0, invalidBallots: 1 }), '5 Stimmen abgegeben, 4 gültig, 1 ungültig.')
  assert.equal(say({ step: 'count', contestId: 'c', ballotsCast: 1, validBallots: 1, noBallots: 1, invalidBallots: 0 }), '1 Stimme abgegeben, 1 gültig, davon 1 „Nein“.')
  assert.equal(say({ step: 'majority', required: 3, elected: 'p' }), 'Absolute Mehrheit: mindestens 3 erste Stellen nötig. Paula Berger erreicht sie.')
  assert.equal(say({ step: 'majority', required: 1, elected: null }), 'Absolute Mehrheit: mindestens 1 erste Stelle nötig. Niemand erreicht sie.')
  assert.equal(say({ step: 'runoff', candidates: ['p', 'r'] }), 'Stichwahl zwischen Paula Berger und Renate Wagner.')
  assert.equal(say({ step: 'positions', excluded: 'r', values: [{ candidateId: 'q', value: 20 }, { candidateId: 'p', value: 20 }] }), 'Die weiteren Positionen nach den Punkten der ersten Runde, ohne Renate Wagner: Quirin Huber-Mayer 20, Paula Berger 20.')
  assert.equal(say({ step: 'positions', excluded: 'r', values: [] }), 'Die weiteren Positionen nach den Punkten der ersten Runde, ohne Renate Wagner: niemand mehr.')
  assert.equal(say({ step: 'lot-required', lot: { id: 'runoff-entry', reason: 'runoff-entry', candidates: ['q', 'r'], seats: 1, qualified: ['p'] } }), 'Losentscheid: Quirin Huber-Mayer und Renate Wagner sind gleichauf; das Los entscheidet, wer von ihnen in die Stichwahl kommt (ein Platz). Bereits in der Stichwahl: Paula Berger.')
  assert.equal(say({ step: 'lot-applied', lotId: 'runoff-entry', order: ['r', 'q'] }), 'Los angewendet: Renate Wagner, Quirin Huber-Mayer.')
  assert.equal(say({ step: 'committee-decision', reason: 'no-valid-ballots' }), 'Keine gültige Stimme: die Wahlkommission entscheidet.')
  assert.equal(say({ step: 'something-new' } as unknown as TraceStep), 'Schritt „something-new“ (von einer neueren Version).')
})

test('a comparison names the figures, who advances and why, and who is tied', () => {
  const firstPlaces: TraceStep = { step: 'compare', basis: 'first-places', seats: 2, values: [{ candidateId: 'p', value: 2 }, { candidateId: 'q', value: 1 }, { candidateId: 'r', value: 1 }], advancing: ['p'], tied: ['q', 'r'] }
  assert.equal(say(firstPlaces), 'Vergleich nach ersten Stellen um 2 Plätze: Paula Berger 2, Quirin Huber-Mayer 1, Renate Wagner 1. Paula Berger kommt weiter, weil 2 > 1 erste Stellen. Gleichauf: Quirin Huber-Mayer und Renate Wagner.')
  const points: TraceStep = { step: 'compare', basis: 'points', seats: 1, values: [{ candidateId: 'q', value: 21 }, { candidateId: 'r', value: 18 }], advancing: ['q'], tied: [] }
  assert.equal(say(points), 'Vergleich nach Punkten der ersten Runde um 1 Platz: Quirin Huber-Mayer 21, Renate Wagner 18. Quirin Huber-Mayer kommt weiter, weil 21 > 18 Punkte.')
  const tie: TraceStep = { step: 'compare', basis: 'points', seats: 1, values: [{ candidateId: 'q', value: 20 }, { candidateId: 'r', value: 20 }], advancing: [], tied: ['q', 'r'] }
  assert.equal(say(tie), 'Vergleich nach Punkten der ersten Runde um 1 Platz: Quirin Huber-Mayer 20, Renate Wagner 20. Gleichauf: Quirin Huber-Mayer und Renate Wagner.')
  const votes: TraceStep = { step: 'compare', basis: 'votes', seats: 1, values: [{ candidateId: 'r', value: 2 }, { candidateId: 'p', value: 1 }], advancing: ['r'], tied: [] }
  assert.equal(say(votes), 'Vergleich nach Stimmen um 1 Platz: Renate Wagner 2, Paula Berger 1. Renate Wagner kommt weiter, weil 2 > 1 Stimmen.')
  const both: TraceStep = { step: 'compare', basis: 'first-places', seats: 2, values: [{ candidateId: 'p', value: 3 }, { candidateId: 'q', value: 2 }, { candidateId: 'r', value: 0 }], advancing: ['p', 'q'], tied: [] }
  assert.equal(say(both), 'Vergleich nach ersten Stellen um 2 Plätze: Paula Berger 3, Quirin Huber-Mayer 2, Renate Wagner 0. Paula Berger und Quirin Huber-Mayer kommen weiter, weil 2 > 0 erste Stellen.')
  assert.equal(valuesText([], NAMES), '')
})

test('the figures of a round as a table: a column per active slot, a row per candidate in contest order', () => {
  const statistics: ContestStatistics = {
    validBallots: 4, noBallots: 0, invalidBallots: 0,
    candidates: [{ candidateId: 'p', firstPlaces: 2, rankCounts: [2, 0, 2], points: 20 }, { candidateId: 'q', firstPlaces: 1, rankCounts: [1, 2, 1], points: 20 }, { candidateId: 'r', firstPlaces: 1, rankCounts: [1, 2, 1], points: 20 }],
  }
  const table = statisticsTable('at-school-speaker-v1', statistics, NAMES)
  assert.deepEqual(table.slots, ['6 Punkte · Schulsprecher/in', '5 Punkte · 1. Stellvertretung Schulsprecher/in', '4 Punkte · 2. Stellvertretung Schulsprecher/in'])
  assert.deepEqual(table.rows.map((row) => [row.name, row.firstPlaces, row.rankCounts, row.points]), [['Paula Berger', 2, [2, 0, 2], 20], ['Quirin Huber-Mayer', 1, [1, 2, 1], 20], ['Renate Wagner', 1, [1, 2, 1], 20]])
  const poll = statisticsTable('single-choice-v1', { validBallots: 3, noBallots: 0, invalidBallots: 0, candidates: [{ candidateId: 'r', firstPlaces: 2, rankCounts: [2], points: 2 }, { candidateId: 'p', firstPlaces: 1, rankCounts: [1], points: 1 }] }, NAMES)
  assert.deepEqual(poll.slots, ['1 Punkt · Stimme'])
  assert.deepEqual(poll.rows.map((row) => row.rankCounts), [[2], [1]])
})
