import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recommendedItems, requiredItems } from '../src/lib/checklist.ts'

const names = { contest: (id: string) => `Wahl ${id}`, group: (id: string) => `Klasse ${id}` }
const doneOf = (items: { done: boolean }[]): string => items.map((item) => (item.done ? '✓' : '○')).join('')

test('a new termin has every item open, and the items about every Wahl or class while there is none', () => {
  const items = requiredItems([{ kind: 'no-contests' }, { kind: 'no-voter-groups' }], names)
  assert.equal(doneOf(items), '○○○○○')
  assert.deepEqual(items.map((item) => item.missing), [[], [], [], [], []])
})

test('each kind of problem keeps its item open and names what is missing', () => {
  const items = requiredItems([
    { kind: 'contest-without-candidates', contestId: '1' },
    { kind: 'voter-group-without-contests', voterGroupId: '2' },
    { kind: 'voter-group-without-contests', voterGroupId: '3' },
  ], names)
  assert.equal(doneOf(items), '✓○✓✓○')
  assert.deepEqual(items[1]?.missing, ['Die Wahl „Wahl 1“ hat noch keine Kandidat:innen.'])
  assert.equal(items[4]?.missing.length, 2)
  assert.equal(doneOf(requiredItems([], names)), '✓✓✓✓✓')
})

test('the recommendations are done without warnings, and say how many are missing', () => {
  assert.equal(doneOf(recommendedItems([])), '✓✓✓')
  const items = recommendedItems([{ kind: 'no-co-admin' }, { kind: 'too-few-witnesses', witnesses: 1 }, { kind: 'pending-invitations', count: 2 }])
  assert.equal(doneOf(items), '○○○')
  assert.deepEqual(items.map((item) => item.missing.length), [0, 1, 1])
  assert.match(items[2]?.missing[0] ?? '', /^2 Einladungen/)
})
