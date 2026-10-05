import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatKey,
  generateKey,
  KEY_ALPHABET,
  KEY_LENGTH,
  KEY_RANDOM_BYTES,
  keyUrl,
  normalizeKey,
  parseKey,
} from '../src/index.ts'
import { prng, randomInt } from './helpers/prng.ts'

function randomBytes(random: () => number): Uint8Array {
  return Uint8Array.from({ length: KEY_RANDOM_BYTES }, () => randomInt(random, 256))
}

/** Keys drawn from a fixed seed, so every run checks the same ones. */
function sampleKeys(seed: number, count: number): string[] {
  const random = prng(seed)
  return Array.from({ length: count }, () => generateKey(randomBytes(random)))
}

test('the alphabet is Crockford Base32: digits and letters without I, L, O and U', () => {
  assert.equal(KEY_ALPHABET.length, 32)
  assert.equal(new Set(KEY_ALPHABET).size, 32)
  assert.deepEqual([...'ILOU'].filter((symbol) => KEY_ALPHABET.includes(symbol)), [])
})

test('a key is 19 random symbols, 95 bits, and a check symbol', () => {
  const zero = new Uint8Array(KEY_RANDOM_BYTES)
  assert.equal(generateKey(zero), '0'.repeat(KEY_LENGTH))
  for (let position = 0; position < KEY_RANDOM_BYTES; position++) {
    // The five low bits of each byte are one symbol, every value of it
    // occurs, and no other symbol depends on them: 19 × 5 bits.
    for (let value = 0; value < 32; value++) {
      const bytes = new Uint8Array(KEY_RANDOM_BYTES)
      bytes[position] = value
      const expected = '0'.repeat(position) + KEY_ALPHABET.charAt(value) + '0'.repeat(KEY_RANDOM_BYTES - position - 1)
      assert.equal(generateKey(bytes).slice(0, KEY_RANDOM_BYTES), expected)
    }
    // The three high bits are not used, so every symbol stays uniform.
    const high = new Uint8Array(KEY_RANDOM_BYTES)
    high[position] = 0b11100000
    assert.equal(generateKey(high), '0'.repeat(KEY_LENGTH))
  }
  assert.throws(() => generateKey(new Uint8Array(KEY_RANDOM_BYTES - 1)), RangeError)
})

test('every generated key parses as itself, and its formatted form too', () => {
  for (const key of sampleKeys(1, 500)) {
    assert.match(key, /^[0-9A-HJKMNP-TV-Z]{20}$/)
    assert.deepEqual(parseKey(key), { ok: true, key })
    const formatted = formatKey(key)
    assert.match(formatted, /^(?:[0-9A-Z]{4}-){4}[0-9A-Z]{4}$/)
    assert.deepEqual(parseKey(formatted), { ok: true, key })
    assert.deepEqual(parseKey(` ${formatted.toLowerCase().replaceAll('-', ' ')} `), { ok: true, key })
  }
})

test('the check symbol catches every single substitution and every adjacent swap', () => {
  for (const key of sampleKeys(2, 200)) {
    for (let position = 0; position < KEY_LENGTH; position++) {
      for (const symbol of KEY_ALPHABET) {
        if (symbol === key[position]) continue
        const typo = key.slice(0, position) + symbol + key.slice(position + 1)
        assert.deepEqual(parseKey(typo), { ok: false, problem: 'check' }, typo)
      }
      const next = key[position + 1]
      if (next === undefined || next === key[position]) continue
      const swapped = key.slice(0, position) + next + key[position] + key.slice(position + 2)
      assert.deepEqual(parseKey(swapped), { ok: false, problem: 'check' }, swapped)
    }
  }
})

test('normalisation reads O as 0 and I and L as 1, ignoring case, spaces and hyphens', () => {
  assert.equal(normalizeKey('o0-Ii Ll\t'), '001111')
  for (const key of sampleKeys(3, 200)) {
    const lookalike = formatKey(key).replaceAll('0', 'O').replaceAll('1', key.length % 2 === 0 ? 'l' : 'I').toLowerCase()
    assert.deepEqual(parseKey(lookalike), { ok: true, key })
    assert.equal(normalizeKey(normalizeKey(lookalike)), key)
  }
})

test('anything else is refused, and says why', () => {
  const [key = ''] = sampleKeys(4, 1)
  assert.deepEqual(parseKey(''), { ok: false, problem: 'length' })
  assert.deepEqual(parseKey(key.slice(1)), { ok: false, problem: 'length' })
  assert.deepEqual(parseKey(`${key}0`), { ok: false, problem: 'length' })
  assert.deepEqual(parseKey(`U${key.slice(1)}`), { ok: false, problem: 'symbol' })
  assert.deepEqual(parseKey(`${key.slice(0, 19)}*`), { ok: false, problem: 'symbol' })
  assert.deepEqual(parseKey(key.slice(0, 19) + (key[19] === 'Z' ? 'Y' : 'Z')), { ok: false, problem: 'check' })
})

test('the card URL carries the key in its fragment, at the app\'s address, base path included', () => {
  const [key = ''] = sampleKeys(5, 1)
  assert.equal(keyUrl('https://wahl.example.org', key), `https://wahl.example.org/v#${key}`)
  assert.equal(keyUrl('https://wahl.example.org/', key), `https://wahl.example.org/v#${key}`)
  assert.equal(keyUrl('https://www.example.org/wahl', key), `https://www.example.org/wahl/v#${key}`)
  assert.equal(keyUrl('https://www.example.org/wahl/', key), `https://www.example.org/wahl/v#${key}`)
  const url = new URL(keyUrl('https://wahl.example.org', key))
  assert.equal(url.pathname + url.search, '/v')
  assert.equal(url.hash, `#${key}`)
})
