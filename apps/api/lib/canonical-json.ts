// Canonical JSON: exactly one text for one value, so a hash over it does not
// depend on key order, whitespace or number formatting, and an independent
// verifier can recompute it from an export.
//
// Objects (keys sorted by UTF-16 code unit), arrays, strings, safe integers,
// booleans and null; nothing else. Values without one portable text are
// refused rather than coerced, because a value that does not survive a JSON
// and PostgreSQL round trip unchanged would make a genuine record fail
// verification later: floats print differently across languages, NaN,
// undefined and functions have no JSON form, integers beyond 2^53 lose
// precision, and PostgreSQL text and jsonb cannot hold U+0000 or a lone
// surrogate.
//
// Pure, with no imports: the offline verifier uses this module as it is.

export type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue }

export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError'
}

// Deep enough for any record this application writes; a cyclic value stops
// here instead of overflowing the stack.
const MAX_DEPTH = 32

export function canonicalJson(value: unknown): string {
  return encode(value, '$', 0)
}

function encode(value: unknown, path: string, depth: number): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      // String(-0) is "0", the same text JSON gives it.
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`${path} must be a safe integer`)
      return String(value)
    case 'string':
      return encodeString(value, path)
    case 'object':
      if (depth >= MAX_DEPTH) throw new CanonicalJsonError(`${path} is nested too deeply`)
      return Array.isArray(value) ? encodeArray(value, path, depth) : encodeObject(value, path, depth)
    default:
      throw new CanonicalJsonError(`${path} has no canonical JSON form (${typeof value})`)
  }
}

function encodeString(value: string, path: string): string {
  if (!value.isWellFormed() || value.includes('\0')) {
    throw new CanonicalJsonError(`${path} must be well-formed Unicode without U+0000`)
  }
  return JSON.stringify(value)
}

function encodeArray(value: readonly unknown[], path: string, depth: number): string {
  const items: string[] = []
  for (let i = 0; i < value.length; i++) {
    if (!(i in value)) throw new CanonicalJsonError(`${path}[${i}] is a hole`)
    items.push(encode(value[i], `${path}[${i}]`, depth + 1))
  }
  return `[${items.join(',')}]`
}

function encodeObject(value: object, path: string, depth: number): string {
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError(`${path} must be a plain object`)
  if (Object.getOwnPropertySymbols(value).length > 0) throw new CanonicalJsonError(`${path} has a symbol key`)
  const record = value as Record<string, unknown>
  const members = Object.keys(record).sort(byCodeUnit).map((key) => {
    const child = `${path}.${key}`
    return `${encodeString(key, child)}:${encode(record[key], child, depth + 1)}`
  })
  return `{${members.join(',')}}`
}

/** UTF-16 code unit order, independent of locale, as JSON Canonicalization (RFC 8785) sorts keys. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
