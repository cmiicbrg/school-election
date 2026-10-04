import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CARDS_PER_PAGE, cardsOf, pageCount, pagesOf, printable, ROUND_LABELS, voterAddress } from '../src/lib/sheet.ts'
import { problemOf, signInUrl } from '../src/lib/api-rules.ts'

const KEYS = ['7KM4P9VX2RNCWQ5DH3TB', '0123456789ABCDEFGHJK']

test('a card carries the key grouped in fours and a URL with the key in the fragment only', () => {
  const [card] = cardsOf(KEYS, 'https://wahl.example.org')
  assert.deepEqual(card, { key: KEYS[0], grouped: '7KM4-P9VX-2RNC-WQ5D-H3TB', url: 'https://wahl.example.org/v#7KM4P9VX2RNCWQ5DH3TB' })
  const url = new URL(card?.url ?? '')
  assert.equal(url.pathname, '/v')
  assert.equal(url.search, '')
  assert.equal(url.hash, '#7KM4P9VX2RNCWQ5DH3TB')
  // The origin is taken as an origin: a path or a trailing slash on it changes nothing.
  assert.equal(cardsOf(KEYS, 'https://wahl.example.org/some/page')[0]?.url, card?.url)
})

test('six cards to a page, the last page shorter, and none for no keys', () => {
  assert.equal(CARDS_PER_PAGE, 6)
  const pages = pagesOf(Array.from({ length: 25 }, (_, n) => n))
  assert.equal(pages.length, pageCount(25))
  assert.deepEqual(pages.map((page) => page.length), [6, 6, 6, 6, 1])
  assert.deepEqual(pages[0], [0, 1, 2, 3, 4, 5])
  assert.deepEqual(pagesOf([]), [])
  assert.equal(pageCount(0), 0)
  assert.equal(pageCount(6), 1)
  assert.equal(pageCount(7), 2)
  assert.throws(() => pagesOf([1], 0), RangeError)
})

test('a batch prints until its round opens, a runoff batch until the runoff is activated, and nothing once the election is final', () => {
  assert.equal(printable({ election: 'draft', regular: 'planned', runoff: null }, 'regular'), true)
  assert.equal(printable({ election: 'prepared', regular: 'planned', runoff: null }, 'regular'), true)
  assert.equal(printable({ election: 'active', regular: 'open', runoff: null }, 'regular'), false)
  assert.equal(printable({ election: 'active', regular: 'closed', runoff: null }, 'regular'), false)
  assert.equal(printable({ election: 'prepared', regular: 'planned', runoff: null }, 'runoff'), true)
  assert.equal(printable({ election: 'active', regular: 'open', runoff: null }, 'runoff'), true)
  assert.equal(printable({ election: 'active', regular: 'closed', runoff: null }, 'runoff'), true)
  assert.equal(printable({ election: 'active', regular: 'closed', runoff: 'open' }, 'runoff'), false)
  assert.equal(printable({ election: 'active', regular: 'closed', runoff: 'closed' }, 'runoff'), false)
  assert.equal(printable({ election: 'final', regular: 'closed', runoff: null }, 'runoff'), false)
})

test('the labels and the typed address', () => {
  assert.deepEqual(ROUND_LABELS, { regular: 'Wahl', runoff: 'Stichwahl' })
  assert.equal(voterAddress('https://wahl.example.org'), 'wahl.example.org/v')
  assert.equal(voterAddress('http://127.0.0.1:3100'), '127.0.0.1:3100/v')
})

test('a refusal keeps the API\'s code and message, and sign-in comes back to a path of this app only', () => {
  const refusal = problemOf(409, { error: 'voting_started' })
  assert.deepEqual([refusal.status, refusal.code, refusal.message], [409, 'voting_started', 'voting_started'])
  const validation = problemOf(400, { error: 'FST_ERR_VALIDATION', message: 'body/count must be >= 1' })
  assert.equal(validation.message, 'body/count must be >= 1')
  assert.equal(problemOf(502, 'not json').code, 'request_failed')
  assert.equal(signInUrl('/elections/1/batches/2/print'), '/api/auth/login?returnTo=%2Felections%2F1%2Fbatches%2F2%2Fprint')
  assert.equal(signInUrl('//evil.example'), '/api/auth/login?returnTo=%2F')
  assert.equal(signInUrl('https://evil.example/'), '/api/auth/login?returnTo=%2F')
})
