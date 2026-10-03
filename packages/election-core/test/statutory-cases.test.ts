import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { firstRoundResult, resolve, runoffResult, type Outcome } from '../src/index.ts'
import { contest, profile } from './helpers/ballots.ts'
import { STATUTORY_CASES, type StatutoryExample } from './fixtures/statutory-cases.ts'

function summary(outcome: Outcome): StatutoryExample['expected'] {
  const sorted = (ids: readonly string[]) => [...ids].sort()
  switch (outcome.kind) {
    case 'final':
      return { kind: outcome.kind, positions: Object.fromEntries(outcome.positions.map((p) => [p.function, p.candidateId])) }
    case 'lot-required':
      return { kind: outcome.kind, lots: outcome.lots.map((lot) => ({ id: lot.id, candidates: sorted(lot.candidates) })) }
    case 'runoff-required':
      return { kind: outcome.kind, runoffCandidates: sorted(outcome.runoffCandidates) }
    case 'tie':
      return { kind: outcome.kind, candidates: sorted(outcome.candidates) }
    case 'committee-decision':
      return { kind: outcome.kind, reason: outcome.reason }
  }
}

function run(example: StatutoryExample): Outcome {
  const c = contest(example.candidates, example.rulesetId)
  const first = firstRoundResult(c, profile(c, example.ballots))
  const lots = example.lots ?? []
  let second
  if (example.runoff !== undefined) {
    // The runoff contest holds the pair the first round (and its entry lot) selected.
    const entry = resolve(first, undefined, lots.filter((lot) => lot.lotId === 'runoff-entry'))
    assert.ok(entry.ok && entry.outcome.kind === 'runoff-required', 'the example needs a runoff')
    const runoff = contest(entry.outcome.runoffCandidates, 'single-choice-v1', 'runoff')
    second = runoffResult(runoff, profile(runoff, example.runoff))
  }
  const resolution = resolve(first, second, lots)
  assert.ok(resolution.ok, 'lot decisions refused')
  return resolution.outcome
}

for (const { ruling, examples } of STATUTORY_CASES) {
  test(`ruling: ${ruling}`, () => {
    assert.ok(examples.length > 0)
    for (const example of examples) assert.deepEqual(summary(run(example)), example.expected, example.name)
  })
}

test('every confirmed row of the rulings table has fixtures, and every fixture a row', () => {
  const design = readFileSync(new URL('../../../docs/design.md', import.meta.url), 'utf8')
  const table = design.slice(design.indexOf('## Statutory rulings'))
  const confirmed = table.split('\n')
    .map((line) => line.split(' | '))
    .filter((cells) => cells.at(-1)?.trim() === 'Confirmed |')
    .map((cells) => (cells[0] ?? '').replace(/^\| /, ''))
  assert.ok(confirmed.length >= 11)
  assert.deepEqual(STATUTORY_CASES.map((c) => c.ruling).sort(), confirmed.sort())
})
