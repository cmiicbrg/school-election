import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pendingKey, takeKey, VOTER_PATH, type HistoryLike } from '../src/voter/bootstrap.ts'

function fakeHistory(): HistoryLike & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    state: { marker: 1 },
    calls,
    replaceState(state, unused, url) {
      calls.push([state, unused, url])
    },
  }
}

test('on the voter page the key is taken out of the fragment and the history entry, and handed over once', () => {
  const history = fakeHistory()
  assert.equal(takeKey({ pathname: '/v', hash: '#7KM4P9VX2RNCWQ5DH3TB' }, history), '7KM4P9VX2RNCWQ5DH3TB')
  assert.deepEqual(history.calls, [[{ marker: 1 }, '', VOTER_PATH]], 'the entry is replaced by /v, the state kept')
  assert.equal(pendingKey(), '7KM4P9VX2RNCWQ5DH3TB')
  assert.equal(pendingKey(), undefined, 'once')
})

test('without a fragment, or on another page, nothing is taken and nothing replaced', () => {
  for (const location of [{ pathname: '/v', hash: '' }, { pathname: '/v', hash: '#' }, { pathname: '/', hash: '#7KM4P9VX2RNCWQ5DH3TB' }, { pathname: '/anmelden', hash: '#x' }]) {
    const history = fakeHistory()
    assert.equal(takeKey(location, history), undefined, JSON.stringify(location))
    assert.deepEqual(history.calls, [])
  }
  assert.equal(pendingKey(), undefined)
})

test('under a base path the voter page is below it, and the entry is replaced by that path', () => {
  const history = fakeHistory()
  assert.equal(takeKey({ pathname: '/wahl/v', hash: '#7KM4P9VX2RNCWQ5DH3TB' }, history, '/wahl'), '7KM4P9VX2RNCWQ5DH3TB')
  assert.deepEqual(history.calls, [[{ marker: 1 }, '', '/wahl/v']])
  assert.equal(pendingKey(), '7KM4P9VX2RNCWQ5DH3TB')
  const elsewhere = fakeHistory()
  assert.equal(takeKey({ pathname: '/v', hash: '#7KM4P9VX2RNCWQ5DH3TB' }, elsewhere, '/wahl'), undefined, 'the root is not the app')
  assert.deepEqual(elsewhere.calls, [])
})

test('whatever the fragment holds is handed over as it is: the page checks it, never this module', () => {
  const history = fakeHistory()
  assert.equal(takeKey({ pathname: '/v', hash: '#not a key' }, history), 'not a key')
  assert.equal(pendingKey(), 'not a key')
})
