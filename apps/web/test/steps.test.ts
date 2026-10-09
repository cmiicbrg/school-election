import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEW_ELECTION, type Lifecycle } from '@school-election/election-core'
import { collapsed, parseMarks, stepStates, STEPS, type StepState } from '../src/lib/steps.ts'

const PREPARED: Lifecycle = { election: 'prepared', regular: 'planned', runoff: null }
const TESTING: Lifecycle = { election: 'prepared', regular: 'testing', runoff: null }
const OPEN: Lifecycle = { election: 'active', regular: 'open', runoff: null }
const FINAL: Lifecycle = { election: 'final', regular: 'closed', runoff: 'closed' }

/** The states in the steps' order, for short comparisons. */
const row = (states: Record<string, StepState>): string => STEPS.map((step) => states[step]?.[0]).join('')

test('without marks, the lifecycle finishes the steps, and the first one it has not is the current one', () => {
  assert.equal(row(stepStates(NEW_ELECTION, {})), 'coooooo')
  assert.equal(row(stepStates(PREPARED, {})), 'dddcooo')
  assert.equal(row(stepStates(OPEN, {})), 'dddddco')
  assert.equal(row(stepStates(FINAL, {})), 'ddddddc')
})

test('a mark finishes a step early, opening a finished one only shows it, and a running Probelauf is never done', () => {
  assert.equal(row(stepStates(NEW_ELECTION, { einrichten: true, mitglieder: true })), 'ddcoooo')
  assert.equal(row(stepStates(PREPARED, { stimmkarten: true })), 'ddddcoo')
  assert.equal(row(stepStates(PREPARED, { stimmkarten: true, probelauf: true })), 'dddddco')
  assert.equal(row(stepStates(OPEN, { einrichten: false })), 'dddddco')
  assert.equal(row(stepStates(TESTING, { stimmkarten: true, probelauf: true })), 'ddddcoo')
})

test('a section is collapsed by its mark, without one when its step is finished, and never while a Probelauf runs', () => {
  assert.equal(collapsed('einrichten', PREPARED, {}), true)
  assert.equal(collapsed('einrichten', OPEN, { einrichten: false }), false)
  assert.equal(collapsed('stimmkarten', PREPARED, {}), false)
  assert.equal(collapsed('stimmkarten', PREPARED, { stimmkarten: true }), true)
  assert.equal(collapsed('probelauf', TESTING, { probelauf: true }), false)
  assert.equal(collapsed('probelauf', FINAL, {}), true)
})

test('stored marks keep known steps with a yes or no, and anything else reads as none', () => {
  assert.deepEqual(parseMarks('{"einrichten":true,"probelauf":false,"wahltag":true,"mitglieder":"ja"}'), { einrichten: true, probelauf: false })
  for (const stored of [null, '', 'nicht json', '[]', 'null', '42']) assert.deepEqual(parseMarks(stored), {}, String(stored))
})
