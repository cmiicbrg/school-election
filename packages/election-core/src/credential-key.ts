// Voting keys: what a card carries, as a QR code and as text to type. The
// server draws the randomness; this module only encodes, checks and
// normalises, so the API and the web app read a key the same way.
//
// A key is 20 symbols of Crockford Base32 (0-9 and A-Z without I, L, O and
// U): 19 random symbols, 95 bits, and one check symbol. It is shown as five
// groups of four, 7KM4-P9VX-2RNC-WQ5D-H3TB, and read case-insensitively,
// ignoring spaces and hyphens, with O read as 0 and I and L as 1.
//
// The check symbol makes the whole key a codeword: reading each symbol s_i
// as an element of GF(2^5) (primitive polynomial x^5 + x^2 + 1, α = x),
// Σ α^i · s_i = 0. A key with one symbol changed, or two adjacent symbols
// swapped, is never a codeword, so a typo is caught before the server is
// asked, and the check needs no symbol outside the alphabet.

export const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Random symbols in a key: 19 × 5 = 95 bits. */
export const KEY_RANDOM_SYMBOLS = 19
/** Symbols in a key, the check symbol included. */
export const KEY_LENGTH = KEY_RANDOM_SYMBOLS + 1
/** Random bytes generateKey takes: one per random symbol, of which it uses the low five bits. */
export const KEY_RANDOM_BYTES = KEY_RANDOM_SYMBOLS

// α^i for i = 0..30 (α has order 31), and the discrete logarithm.
const EXP: number[] = []
const LOG: number[] = Array.from({ length: 32 }, () => 0)
for (let i = 0, value = 1; i < 31; i++) {
  EXP.push(value)
  LOG[value] = i
  value <<= 1
  if (value & 0b100000) value ^= 0b100101
}

function multiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[((LOG[a] ?? 0) + (LOG[b] ?? 0)) % 31] ?? 0
}

/** Σ α^i · s_i over the given symbol values. */
function weightedSum(values: readonly number[]): number {
  let sum = 0
  for (const [i, value] of values.entries()) sum ^= multiply(EXP[i % 31] ?? 0, value)
  return sum
}

const VALUE = new Map([...KEY_ALPHABET].map((symbol, value) => [symbol, value]))

function symbolOf(value: number): string {
  return KEY_ALPHABET[value] ?? ''
}

/**
 * A key from caller-supplied random bytes: each of the first 19 bytes gives
 * one symbol by its low five bits (uniform, since 256 is a multiple of 32),
 * and the check symbol follows. The caller draws the bytes from a
 * cryptographically secure generator.
 */
export function generateKey(random: Uint8Array): string {
  if (random.length < KEY_RANDOM_BYTES) throw new RangeError(`a key needs ${KEY_RANDOM_BYTES} random bytes, got ${random.length}`)
  const values = Array.from(random.subarray(0, KEY_RANDOM_SYMBOLS), (byte) => byte & 0b11111)
  // α^19 · c = Σ α^i · s_i (addition is subtraction in GF(2^5)), so c = α^12 · Σ.
  const check = multiply(EXP[31 - KEY_RANDOM_SYMBOLS] ?? 0, weightedSum(values))
  return [...values, check].map(symbolOf).join('')
}

/**
 * What was typed or scanned, in the stored form: upper case, without spaces
 * or hyphens, O as 0 and I and L as 1. Says nothing about whether it is a key.
 */
export function normalizeKey(input: string): string {
  return input
    .toUpperCase()
    .replaceAll(/[\s-]/g, '')
    .replaceAll('O', '0')
    .replaceAll(/[IL]/g, '1')
}

export type KeyProblem
  = | 'length' // not 20 symbols
    | 'symbol' // a character outside the alphabet, such as U
    | 'check' // a typo: the check symbol does not match

export type ParsedKey
  = | { readonly ok: true, readonly key: string }
    | { readonly ok: false, readonly problem: KeyProblem }

/** Normalises the input and checks that it is a well-formed key with a matching check symbol. */
export function parseKey(input: string): ParsedKey {
  const key = normalizeKey(input)
  if (key.length !== KEY_LENGTH) return { ok: false, problem: 'length' }
  const values = [...key].map((symbol) => VALUE.get(symbol))
  if (values.some((value) => value === undefined)) return { ok: false, problem: 'symbol' }
  return weightedSum(values as number[]) === 0 ? { ok: true, key } : { ok: false, problem: 'check' }
}

/** A normalised key as it is printed: five groups of four, joined by hyphens. */
export function formatKey(key: string): string {
  return key.match(/.{1,4}/g)?.join('-') ?? ''
}

/**
 * The URL a card's QR code carries: the voter page with the key in the
 * fragment, which the browser never sends to the server. The origin is
 * the public origin, such as https://wahl.example.org.
 */
export function keyUrl(origin: string, key: string): string {
  return `${new URL(origin).origin}/v#${key}`
}
