import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKey, KEY_RANDOM_BYTES } from '@school-election/election-core'
import { refusalOf, type VoterContest } from '../src/voter/voter-api.ts'
import { candidateName, castText, emptyRowsText, GENERAL_MESSAGE, groupedKey, keyHint, KEY_HINTS, messageFor, movedText, pointsLabel, remainingText, slotRows, VOTER_MESSAGES, WRONG_ROUND, yesOrNo } from '../src/voter/voter-rules.ts'

const KEY = generateKey(Uint8Array.from({ length: KEY_RANDOM_BYTES }, (_, n) => n * 7))

function contest(rulesetId: VoterContest['rulesetId'], candidates: number): Pick<VoterContest, 'id' | 'rulesetId' | 'candidates'> {
  return {
    id: 'c1',
    rulesetId,
    candidates: Array.from({ length: candidates }, (_, n) => ({ id: `k${n}`, surname: `S${n}`, givenName: `G${n}`, picture: null })),
  }
}

test('a code typed in lower case with spaces, hyphens and an O is shown as the card prints it, and passes', () => {
  const typed = KEY.toLowerCase().match(/.{1,4}/g)?.join(' - ')?.replaceAll('0', 'o') ?? ''
  assert.equal(groupedKey(typed), KEY.match(/.{1,4}/g)?.join('-'))
  assert.equal(keyHint(typed), null)
  assert.equal(groupedKey('7km4p'), '7KM4-P', 'grouped as far as it goes')
})

test('the hints name the length, a symbol outside the alphabet and a typo, and the API\'s refusal of a code gets the same words', () => {
  assert.equal(keyHint(KEY.slice(0, 19)), KEY_HINTS.length)
  assert.equal(keyHint(`${KEY.slice(0, 19)}U`), KEY_HINTS.symbol)
  const last = KEY[19] === 'A' ? 'B' : 'A'
  assert.equal(keyHint(`${KEY.slice(0, 19)}${last}`), KEY_HINTS.check)
  assert.equal(messageFor(refusalOf(400, { error: 'invalid_key', problem: 'length' })), KEY_HINTS.length)
  assert.equal(messageFor(refusalOf(400, { error: 'invalid_key', problem: 'nonsense' })), KEY_HINTS.check)
})

test('I, L and O are read as 1 and 0, so only a character no code has is refused as a symbol', () => {
  const withLetters = KEY.replaceAll('1', 'l').replaceAll('0', 'O')
  assert.equal(keyHint(withLetters), null)
  assert.equal(keyHint(`${KEY.slice(0, 19)}Ä`), KEY_HINTS.symbol)
  assert.match(KEY_HINTS.symbol, /kommt in Codes nicht vor/)
  assert.doesNotMatch(KEY_HINTS.symbol, /ohne I, L, O/)
})

test('every answer of the voter API has its sentence; anything else gets the general one', () => {
  for (const code of ['unknown_key', 'invalid_key', 'round_planned', 'round_closed', 'rate_limited', 'no_session', 'already_voted', 'not_entitled', 'invalid_ballot', 'cross_site_request', 'internal_error']) {
    const message = VOTER_MESSAGES[code]
    assert.ok(message && message.length > 10, code)
    assert.equal(messageFor(refusalOf(400, { error: code })), message)
  }
  assert.equal(messageFor(refusalOf(503, {})), GENERAL_MESSAGE)
  assert.equal(messageFor(refusalOf(400, { error: 'something_new' })), GENERAL_MESSAGE)
  assert.equal(messageFor(new TypeError('failed to fetch')), GENERAL_MESSAGE)
})

test('a card whose Wahlgang takes no votes now hears which Wahlgang it is for: a 1. Wahlgang card in the runoff is over, a runoff card early is not yet valid', () => {
  assert.equal(refusalOf(409, { error: 'round_closed', round: 'regular' }).round, 'regular')
  assert.equal(refusalOf(409, { error: 'round_closed', round: 'second' }).round, undefined, 'only the two Wahlgänge')
  assert.equal(messageFor(refusalOf(409, { error: 'round_closed', round: 'regular' })),
    'Der 1. Wahlgang ist beendet; diese Stimmkarte gilt nicht mehr. Für eine Stichwahl gibt es eigene Stimmkarten.')
  assert.equal(messageFor(refusalOf(409, { error: 'round_planned', round: 'runoff' })),
    'Das ist eine Stichwahl-Stimmkarte. Sie gilt erst, wenn die Stichwahl beginnt.')
  assert.equal(messageFor(refusalOf(409, { error: 'round_closed', round: 'runoff' })),
    'Die Stichwahl ist beendet. Es können keine Stimmen mehr abgegeben werden.')
  assert.equal(messageFor(refusalOf(409, { error: 'round_planned', round: 'regular' })), VOTER_MESSAGES.round_planned)
  assert.equal(WRONG_ROUND.regular.round_planned, VOTER_MESSAGES.round_planned)
  // Without the card's Wahlgang, as a session's refusal comes: the words of the code alone.
  assert.equal(messageFor(refusalOf(409, { error: 'round_closed' })), VOTER_MESSAGES.round_closed)
})

test('the rows of a ballot are the active slots: four candidates show four, seven show six, one shows Ja/Nein', () => {
  assert.deepEqual(slotRows(contest('at-school-speaker-v1', 3)).map((row) => [row.rank, row.points, row.label]), [
    [1, 6, 'Schulsprecher/in'], [2, 5, '1. Stellvertretung Schulsprecher/in'], [3, 4, '2. Stellvertretung Schulsprecher/in'],
  ])
  assert.deepEqual(slotRows(contest('at-school-speaker-v1', 4)).map((row) => row.points), [6, 5, 4, 3])
  assert.deepEqual(slotRows(contest('at-school-speaker-v1', 7)).map((row) => row.points), [6, 5, 4, 3, 2, 1])
  assert.deepEqual(slotRows(contest('at-representative-v1', 2)).map((row) => [row.points, row.label]), [[2, 'Vertreter/in'], [1, 'Stellvertreter/in']])
  assert.deepEqual(slotRows(contest('single-choice-v1', 3)).map((row) => [row.points, row.label]), [[1, 'Stimme']])
  assert.equal(yesOrNo(contest('at-representative-v1', 1)), true)
  assert.equal(yesOrNo(contest('single-choice-v1', 1)), true)
  assert.equal(yesOrNo(contest('single-choice-v1', 2)), false)
})

test('the words for points, names, what is left and empty rows', () => {
  assert.equal(pointsLabel(6), '6 Punkte')
  assert.equal(pointsLabel(1), '1 Punkt')
  assert.equal(candidateName({ surname: 'Berger', givenName: 'Paula' }), 'Paula Berger')
  assert.equal(remainingText(2), 'Noch 2 Wahlen offen.')
  assert.equal(remainingText(1), 'Noch 1 Wahl offen.')
  assert.equal(remainingText(0), 'Sie haben in allen Wahlen abgestimmt.')
  assert.equal(emptyRowsText(1, 2), '1 von 2 Zeilen ist leer')
  assert.equal(emptyRowsText(2, 3), '2 von 3 Zeilen sind leer')
  assert.equal(castText('Schulsprecher/in', 1), 'Stimme für „Schulsprecher/in“ abgegeben. Noch 1 Wahl offen.')
  assert.equal(movedText('Paula Berger', 6, 5), 'Paula Berger steht jetzt in der Zeile mit 6 Punkten; die Zeile mit 5 Punkten ist leer.')
  assert.equal(movedText('Lena Bauer', 1, 2), 'Lena Bauer steht jetzt in der Zeile mit 1 Punkt; die Zeile mit 2 Punkten ist leer.')
})
