import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initials, ownMember } from '../src/lib/people.ts'
import type { Member } from '../src/lib/types.ts'

test('initials are the first letters of the first and the last word', () => {
  assert.equal(initials('Anna Lehrerin'), 'AL')
  assert.equal(initials('Carla Maria von Kollegin'), 'CK')
  assert.equal(initials('Lehrerin, Anna'), 'LA')
  assert.equal(initials('Özlem Şahin'), 'ÖŞ')
  assert.equal(initials('wanda'), 'W')
  assert.equal(initials('  (Anna)  Lehrerin '), 'AL')
  assert.equal(initials(''), '')
  assert.equal(initials('– 42 –'), '')
})

const member = (id: string, role: Member['role'], displayName: string | null, status: Member['status'] = 'bound'): Member =>
  ({ id, role, status, email: null, displayName })

test('the own member is the one signed in with the caller\'s role and name, and none where that is not one', () => {
  const members = [
    member('1', 'owner', 'Anna Lehrerin'),
    member('2', 'admin', 'Carla Kollegin'),
    member('3', 'witness', 'Wanda Zeugin'),
    member('4', 'witness', 'Wanda Zeugin'),
    member('5', 'witness', null, 'pending'),
  ]
  assert.equal(ownMember(members, 'owner', 'Anna Lehrerin')?.id, '1')
  assert.equal(ownMember(members, 'admin', 'Carla Kollegin')?.id, '2')
  // Another role under the same name is someone else.
  assert.equal(ownMember(members, 'admin', 'Anna Lehrerin'), undefined)
  // Two witnesses of that name: the list cannot tell which one is the caller.
  assert.equal(ownMember(members, 'witness', 'Wanda Zeugin'), undefined)
})
