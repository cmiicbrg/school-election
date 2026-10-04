// The limiter without a server: delays that grow and cap, a cap on
// failing answers in flight, a source that starts over after quiet, and
// a count that never throttles.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AttemptLimiter } from '../lib/attempt-limiter.ts'

function clock(start = 1_000_000) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

test('a source waits longer with every unknown key, up to the cap, and starts over after a quiet while', () => {
  const time = clock()
  const limiter = new AttemptLimiter({ baseDelayMs: 500, maxDelayMs: 4_000, quietMs: 60_000, now: time.now })
  const delays: number[] = []
  for (let i = 0; i < 6; i++) {
    const verdict = limiter.begin('10.0.0.1')
    assert.notEqual(verdict, 'refused')
    if (verdict !== 'refused') delays.push(verdict.delayMs)
    limiter.end('10.0.0.1')
    time.advance(1_000)
  }
  assert.deepEqual(delays, [250, 500, 1_000, 2_000, 4_000, 4_000])
  assert.equal(limiter.failures, 6)
  time.advance(61_000)
  const again = limiter.begin('10.0.0.1')
  assert.deepEqual(again, { delayMs: 250 })
  // Another source is another count.
  assert.deepEqual(limiter.begin('10.0.0.2'), { delayMs: 250 })
})

test('more than a handful of failing answers in flight from one source are refused, until they went out', () => {
  const limiter = new AttemptLimiter({ maxInFlight: 3, now: clock().now })
  for (let i = 0; i < 3; i++) assert.notEqual(limiter.begin('10.0.0.1'), 'refused')
  assert.equal(limiter.begin('10.0.0.1'), 'refused')
  assert.notEqual(limiter.begin('10.0.0.9'), 'refused', 'another source is not concerned')
  limiter.end('10.0.0.1')
  assert.notEqual(limiter.begin('10.0.0.1'), 'refused')
  // A refusal counts as no failure of the source, and ending one that never began changes nothing.
  limiter.end('nobody')
  assert.equal(limiter.failures, 5)
})

test('quiet sources are forgotten once there are many, so the map stays the size of the nuisance', () => {
  const time = clock()
  const limiter = new AttemptLimiter({ quietMs: 1_000, now: time.now })
  for (let i = 0; i < 1_200; i++) {
    limiter.begin(`source-${i}`)
    limiter.end(`source-${i}`)
  }
  time.advance(2_000)
  limiter.begin('fresh')
  // A forgotten source starts over, as a quiet one does.
  assert.deepEqual(limiter.begin('source-0'), { delayMs: 250 })
})
