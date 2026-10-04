// The people of the tests: teachers with the global teacher role, and a
// student who is invited as a witness. The API tests sign them in through
// the fake Entra's claims; the browser journeys choose them on its sign-in
// page.

export interface Person {
  oid: string
  name: string
  /** The email claim; undefined leaves it out. */
  email?: string
  preferredUsername?: string
  roles?: string[]
}

export const ANNA: Person = { oid: 'a0000000-0000-4000-8000-00000000000a', name: 'Anna Lehrerin', email: 'anna.lehrerin@schule.example.org', roles: ['teacher'] }
export const BERND: Person = { oid: 'b0000000-0000-4000-8000-00000000000b', name: 'Bernd Lehrer', email: 'bernd.lehrer@schule.example.org', roles: ['teacher'] }
export const CARLA: Person = { oid: 'c0000000-0000-4000-8000-00000000000c', name: 'Carla Kollegin', email: 'carla.kollegin@schule.example.org', roles: ['teacher'] }
export const WANDA: Person = { oid: 'd0000000-0000-4000-8000-00000000000d', name: 'Wanda Zeugin', email: 'wanda.zeugin@schule.example.org' }

export const PERSONAS: readonly Person[] = [ANNA, BERND, CARLA, WANDA]

/** The ID token claims of a person, as Entra would send them. */
export function claimsOf(person: Person): Record<string, unknown> {
  return {
    oid: person.oid,
    name: person.name,
    email: person.email,
    preferred_username: person.preferredUsername ?? person.email,
    roles: person.roles ?? [],
  }
}
