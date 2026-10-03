// How names are cleaned, compared and ordered: one place for the whole
// server, so the setup screens, the ballot and every list show candidates,
// contests and voter groups in the same order, and the browser never sorts
// on its own.
//
// Candidates are listed alphabetically by surname, then given name, in
// German collation, as the regulation lists them on the ballot (§ 10 Abs. 3).
// Two candidates of one contest whose names compare equal are refused
// rather than ordered by some tiebreak, so the order is always determined
// by the names alone. Comparison ignores case ("Müller" and "MÜLLER" are the
// same name) but not accents ("Muller" and "Müller" are not).

/** German collation, case-insensitive, accent-sensitive. */
const NAME_COLLATOR = new Intl.Collator('de-AT', { usage: 'sort', sensitivity: 'accent' })
/** The same, with digits compared as numbers, so class 2A comes before 10A. */
const LABEL_COLLATOR = new Intl.Collator('de-AT', { usage: 'sort', sensitivity: 'accent', numeric: true })

/**
 * A name or title as it is stored: Unicode NFC, so the same letters are the
 * same bytes, without leading or trailing white space, and with every run
 * of white space inside as one space.
 */
export function cleanName(value: string): string {
  return value.normalize('NFC').trim().replaceAll(/\s+/gu, ' ')
}

export interface CandidateName {
  surname: string
  givenName: string
}

/** The ballot order: surname, then given name. */
export function compareCandidates(a: CandidateName, b: CandidateName): number {
  return NAME_COLLATOR.compare(a.surname, b.surname) || NAME_COLLATOR.compare(a.givenName, b.givenName)
}

/** Whether two candidates of one contest would have the same name: such a pair is refused. */
export function sameCandidateName(a: CandidateName, b: CandidateName): boolean {
  return compareCandidates(a, b) === 0
}

/** Contests by title and voter groups by name, numbers as numbers. */
export function compareLabels(a: string, b: string): number {
  return LABEL_COLLATOR.compare(a, b)
}
