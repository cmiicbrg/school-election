import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanName, compareCandidates, compareLabels, sameCandidateName } from '../lib/names.ts'

const name = (surname: string, givenName: string) => ({ surname, givenName })

test('names are stored in NFC, trimmed, with single spaces', () => {
  assert.equal(cleanName('  Müller \t Lüdenscheid  '), 'Müller Lüdenscheid')
  assert.equal(cleanName('Anne-Marie'), 'Anne-Marie')
})

test('candidates are ordered by surname, then given name, in German collation', () => {
  const names = [
    name('Zöhrer', 'Anna'), name('Österreicher', 'Max'), name('Ofner', 'Lisa'), name('Müller', 'Anna'),
    name('Müller', 'Andreas'), name('Muller', 'Zoe'), name('Abel', 'Zoe'), name('Äbel', 'Anna'),
  ]
  assert.deepEqual(names.toSorted(compareCandidates).map((n) => `${n.surname} ${n.givenName}`), [
    'Abel Zoe', 'Äbel Anna', 'Muller Zoe', 'Müller Andreas', 'Müller Anna', 'Ofner Lisa', 'Österreicher Max', 'Zöhrer Anna',
  ])
})

test('two names are the same when they differ in case only, never when an accent differs', () => {
  assert.equal(sameCandidateName(name('Müller', 'Anna'), name('MÜLLER', 'anna')), true)
  for (const other of [name('Muller', 'Anna'), name('Müller', 'Änna'), name('Müller', 'Anna Maria'), name('Anna', 'Müller')]) {
    assert.equal(sameCandidateName(name('Müller', 'Anna'), other), false, `${other.surname} ${other.givenName}`)
  }
})

test('labels compare numbers as numbers', () => {
  assert.deepEqual(['10A', '2A', '1B', '1A'].toSorted(compareLabels), ['1A', '1B', '2A', '10A'])
})
