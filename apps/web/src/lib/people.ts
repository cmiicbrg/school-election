// People as the pages show them: initials beside a name, and which member
// of a termin is the person signed in.

import type { Role } from './labels.ts'
import type { Member } from './types.ts'

/** The first letters of a name's first and last word, upper case: "Anna Lehrerin" → "AL"; "" for a name without letters. */
export function initials(name: string): string {
  const words = name.split(/[\s,]+/).filter((word) => /\p{L}/u.test(word))
  const first = words[0]?.match(/\p{L}/u)?.[0] ?? ''
  const last = words.length > 1 ? (words.at(-1)?.match(/\p{L}/u)?.[0] ?? '') : ''
  return `${first}${last}`.toLocaleUpperCase('de')
}

/**
 * The member who is the caller: the one signed in with the caller's role
 * under the caller's name. The members' list carries no user ids, so a
 * caller whose name two members of that role share is none of them.
 */
export function ownMember(members: readonly Member[], role: Role, displayName: string): Member | undefined {
  const matches = members.filter((member) => member.status === 'bound' && member.role === role && member.displayName === displayName)
  return matches.length === 1 ? matches[0] : undefined
}
