import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeSlots, isRulesetId, RULESETS } from '../src/index.ts'

const points = (slots: readonly { points: number }[]) => slots.map((s) => s.points)
const speaker = RULESETS['at-school-speaker-v1']
const representative = RULESETS['at-representative-v1']

test('the school speaker ruleset carries the statutory points 6..1 with their functions', () => {
  assert.deepEqual(points(speaker.slots), [6, 5, 4, 3, 2, 1])
  assert.deepEqual(speaker.slots.map((s) => s.rank), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(speaker.slots.map((s) => s.function), [
    'school-speaker',
    'school-speaker-deputy-1',
    'school-speaker-deputy-2',
    'sga-deputy-1',
    'sga-deputy-2',
    'sga-deputy-3',
  ])
})

test('the representative ruleset carries the statutory points 2, 1', () => {
  assert.deepEqual(points(representative.slots), [2, 1])
  assert.deepEqual(representative.slots.map((s) => s.function), ['representative', 'deputy'])
})

test('the single-choice ruleset has exactly one slot', () => {
  assert.deepEqual(points(RULESETS['single-choice-v1'].slots), [1])
})

for (const [candidates, expected] of [
  [1, [6]],
  [2, [6, 5]],
  [3, [6, 5, 4]],
  [4, [6, 5, 4, 3]],
  [5, [6, 5, 4, 3, 2]],
  [6, [6, 5, 4, 3, 2, 1]],
  [7, [6, 5, 4, 3, 2, 1]],
  [10, [6, 5, 4, 3, 2, 1]],
] as const) {
  test(`${candidates} school speaker candidates have the active slots [${expected.join(',')}]`, () => {
    assert.deepEqual(points(activeSlots(speaker, candidates)), expected)
  })
}

test('representative contests use [2] for one candidate and [2,1] from two on', () => {
  assert.deepEqual(points(activeSlots(representative, 1)), [2])
  assert.deepEqual(points(activeSlots(representative, 2)), [2, 1])
  assert.deepEqual(points(activeSlots(representative, 9)), [2, 1])
})

test('a contest without candidates has no ballot', () => {
  assert.throws(() => activeSlots(speaker, 0), RangeError)
  assert.throws(() => activeSlots(speaker, -1), RangeError)
  assert.throws(() => activeSlots(speaker, 2.5), RangeError)
})

test('rulesets are frozen, so points cannot be changed at runtime', () => {
  assert.ok(Object.isFrozen(RULESETS))
  assert.ok(Object.isFrozen(speaker.slots))
  assert.ok(speaker.slots.every((slot) => Object.isFrozen(slot)))
  assert.throws(() => {
    (speaker.slots[0] as { points: number }).points = 4
  }, TypeError)
})

test('isRulesetId accepts only the defined ids', () => {
  assert.ok(isRulesetId('at-school-speaker-v1'))
  assert.ok(!isRulesetId('at-school-speaker-v2'))
  assert.ok(!isRulesetId('toString'))
  assert.ok(!isRulesetId(undefined))
})
