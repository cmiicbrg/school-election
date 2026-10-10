import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allDrawn, drawCodes } from '../src/lib/qr-images.ts'
import { cardsOf } from '../src/lib/sheet.ts'

const KEYS = ['7KM4P9VX2RNCWQ5DH3TB', 'ABCDEFGHJKMNPQRSTVWX']

test('every card gets a QR image of its own, and the sheets wait for all of them', async () => {
  const cards = cardsOf(KEYS, 'https://wahl.example.org')
  const images = await drawCodes(cards)
  assert.deepEqual([...images.keys()], KEYS)
  for (const image of images.values()) assert.match(image, /^data:image\/png;base64,/)
  assert.notEqual(images.get(KEYS[0] ?? ''), images.get(KEYS[1] ?? ''))
  assert.equal(allDrawn(cards, images), true)
  assert.equal(allDrawn(cards, new Map([[KEYS[0] ?? '', images.get(KEYS[0] ?? '') ?? '']])), false)
  assert.equal(allDrawn(cards, new Map([[KEYS[0] ?? '', ''], [KEYS[1] ?? '', 'data:x']])), false)
})
