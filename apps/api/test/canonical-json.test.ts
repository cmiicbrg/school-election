import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson, CanonicalJsonError } from '../lib/canonical-json.ts'

const refused = (value: unknown, path: RegExp) =>
  assert.throws(() => canonicalJson(value), (err: Error) => err instanceof CanonicalJsonError && path.test(err.message))

test('the text does not depend on key order or nesting order', () => {
  const a = { b: 1, a: { d: true, c: null }, list: [{ y: 'y', x: 'x' }] }
  const b = { list: [{ x: 'x', y: 'y' }], a: { c: null, d: true }, b: 1 }
  assert.equal(canonicalJson(a), '{"a":{"c":null,"d":true},"b":1,"list":[{"x":"x","y":"y"}]}')
  assert.equal(canonicalJson(b), canonicalJson(a))
})

test('keys sort by UTF-16 code unit, not by locale or code point', () => {
  // U+FF61 is one code unit above the surrogate pair of U+1F600, though its
  // code point is lower.
  const value = { 'b': 0, 'a': 0, 'B': 0, 'é': 0, '\u{1F600}': 0, '｡': 0, '': 0 }
  assert.equal(canonicalJson(value), '{"":0,"B":0,"a":0,"b":0,"é":0,"\u{1F600}":0,"｡":0}')
})

test('arrays keep their order, and scalars are written as JSON writes them', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]')
  assert.equal(canonicalJson([]), '[]')
  assert.equal(canonicalJson({}), '{}')
  assert.equal(canonicalJson([null, true, false, 0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]),
    '[null,true,false,0,-1,9007199254740991,-9007199254740991]')
  assert.equal(canonicalJson(-0), '0')
  const text = 'quote " backslash \\ newline \n tab \t control \u0001 umlaut ä emoji \u{1F600}'
  assert.equal(canonicalJson(text), JSON.stringify(text))
  assert.equal(canonicalJson(Object.assign(Object.create(null) as object, { k: 'v' })), '{"k":"v"}')
})

test('only safe integers are numbers', () => {
  for (const value of [1.5, -0.1, 1e21, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, -(2 ** 53)]) {
    refused(value, /^\$ must be a safe integer$/)
  }
  refused({ count: 0.5 }, /^\$\.count must be a safe integer$/)
})

test('undefined, functions, symbols and bigints are refused, not skipped', () => {
  refused(undefined, /^\$ has no canonical JSON form \(undefined\)$/)
  refused({ a: undefined }, /^\$\.a has no canonical JSON form \(undefined\)$/)
  refused([1, undefined], /^\$\[1\] has no canonical JSON form \(undefined\)$/)
  refused({ f: () => 1 }, /^\$\.f has no canonical JSON form \(function\)$/)
  refused(Symbol('s'), /\(symbol\)$/)
  refused(1n, /\(bigint\)$/)
  refused({ [Symbol('s')]: 1 }, /^\$ has a symbol key$/)
})

test('objects other than plain ones, and arrays with holes, are refused', () => {
  class Point {
    x = 1
  }
  for (const value of [new Date(0), new Map(), new Set(), /x/, new Point(), new Uint8Array(1)]) {
    refused(value, /^\$ must be a plain object$/)
  }

  refused([1, , 3], /^\$\[1\] is a hole$/)
})

test('nothing of an array or object is left out: no inherited items, no extra or hidden properties', () => {
  // A hole filled from a prototype would otherwise encode like [1,2].
  const inherited = Object.setPrototypeOf([1, ,], Object.assign(Object.create(Array.prototype) as object, { 1: 2 })) as unknown[]
  refused(inherited, /^\$ must be a plain array$/)
  Object.defineProperty(Array.prototype, 1, { value: 2, configurable: true })
  try {
    refused([1, ,], /^\$\[1\] is a hole$/)
  } finally {
    delete (Array.prototype as unknown as Record<number, unknown>)[1]
  }
  class Items extends Array<number> {}
  refused(Items.from([1]), /^\$ must be a plain array$/)
  refused(Object.assign([1, 2], { note: 'x' }), /^\$ has properties besides its items$/)
  refused(Object.assign([1], { [Symbol('s')]: 1 }), /^\$ has properties besides its items$/)
  refused(Object.defineProperty({ a: 1 }, 'hidden', { value: 2, enumerable: false }), /^\$ has a non-enumerable property$/)
})

test('strings that PostgreSQL could not store unchanged are refused, as values and as keys', () => {
  refused('lone \uD800 surrogate', /^\$ must be well-formed Unicode without U\+0000$/)
  refused('nul \0 character', /^\$ must be well-formed Unicode without U\+0000$/)
  refused({ '\uDC00': 1 }, /^\$\.\uDC00 must be well-formed Unicode without U\+0000$/)
  refused({ a: { 'b\0': 1 } }, /^\$\.a\.b\0 must be well-formed/)
})

test('a cyclic value is refused instead of overflowing the stack', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  refused(cyclic, /is nested too deeply$/)
})
