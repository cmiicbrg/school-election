import { test } from 'node:test'
import assert from 'node:assert/strict'
import { currentSession, inLane, keyQueued, nextSession, queueKey, stale, takeQueuedKey } from '../src/voter/lane.ts'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

test('the lane runs one request after another, a failed one not holding the next', async () => {
  const order: string[] = []
  let release: () => void = () => {}
  inLane(() => new Promise<void>((resolve) => {
    order.push('first started')
    release = resolve
  }))
  inLane(async () => {
    order.push('second')
    throw new Error('answered for by nobody')
  })
  inLane(async () => {
    order.push('third')
  })
  await tick()
  assert.deepEqual(order, ['first started'], 'the second waits for the first')
  release()
  await tick()
  assert.deepEqual(order, ['first started', 'second', 'third'])
})

test('a request speaks for the page only in the session it started in', () => {
  const mine = currentSession()
  assert.equal(stale(mine), false)
  assert.equal(nextSession(), mine + 1)
  assert.equal(stale(mine), true)
  assert.equal(stale(currentSession()), false)
})

test('of keys queued while the lane is busy, only the latest is taken, once', () => {
  assert.equal(keyQueued(), false)
  queueKey('first')
  queueKey('second')
  assert.equal(keyQueued(), true)
  assert.equal(takeQueuedKey(), 'second')
  assert.equal(keyQueued(), false)
  assert.equal(takeQueuedKey(), undefined)
})
