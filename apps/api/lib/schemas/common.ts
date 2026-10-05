import { Type, type TProperties } from 'typebox'

/**
 * An object schema that rejects unknown properties. Every request and
 * response schema uses it: request bodies are refused rather than silently
 * trimmed, and a response cannot carry a field nobody declared.
 */
export function StrictObject<P extends TProperties>(properties: P) {
  return Type.Object(properties, { additionalProperties: false })
}

export const ErrorResponse = StrictObject({
  error: Type.String(),
  message: Type.Optional(Type.String()),
})

export const HealthResponse = StrictObject({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  db: Type.Union([Type.Literal('up'), Type.Literal('down')]),
  /** Whether any round of any election accepts ballots now: an update or a restart would interrupt voting. False when the database cannot be asked. */
  busy: Type.Boolean(),
  /** The running release and commit, so an operator can confirm what a deploy started. */
  version: Type.String(),
  gitSha: Type.String(),
  /** The counting semantics this server tallies with (election-core TALLY_VERSION). */
  tallyVersion: Type.Integer(),
})

// Patterns run with the u flag: \p{Cc} are control characters, \p{Cs} lone
// surrogates, which PostgreSQL text and the audit log cannot hold as sent.
const PLAIN = String.raw`[^\p{Cc}\p{Cs}]`

/** One line of text, not blank: a title or a name. No line or paragraph separator (\p{Zl}, \p{Zp}) either. */
export function SingleLineText(maxLength: number) {
  return Type.String({ minLength: 1, maxLength, pattern: String.raw`^(?=.*\S)[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}]+$` })
}

/** Text over several lines: no control characters but tab and line breaks; `minLength` where it must not be empty. */
export function MultiLineText(maxLength: number, minLength = 0) {
  return Type.String({ minLength, maxLength, pattern: String.raw`^(?:${PLAIN}|[\t\n\r])*$` })
}

/** An e-mail address as a school account has it: local@domain.tld, nothing to trim. */
export const EmailAddress = Type.String({
  minLength: 5,
  maxLength: 254,
  pattern: String.raw`^[^\s@\p{Cc}\p{Cs}]+@[^\s@\p{Cc}\p{Cs}]+\.[^\s@\p{Cc}\p{Cs}]+$`,
})

/** One of a fixed list of strings. */
export function Literals<T extends string>(values: readonly T[]) {
  return Type.Enum([...values])
}

/** A lowercase or uppercase UUID, as PostgreSQL accepts it. */
export const Uuid = Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })
