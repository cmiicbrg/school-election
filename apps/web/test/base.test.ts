import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basePathOf, joinBase, stripBase } from '../src/lib/base.ts'

test('the base path is the meta tag\'s content without its trailing slash: nothing at the root', () => {
  assert.equal(basePathOf('/'), '')
  assert.equal(basePathOf('/wahl/'), '/wahl')
  assert.equal(basePathOf('/wahl'), '/wahl')
  assert.equal(basePathOf('/schule/wahl-2026/'), '/schule/wahl-2026')
  // Without the tag (a page the server did not send) the app is at the root.
  assert.equal(basePathOf(null), '')
  assert.equal(basePathOf(undefined), '')
})

test('a path of the app goes under the base path and comes back out of it; a path outside stays as it is', () => {
  assert.equal(joinBase('', '/api/auth/me'), '/api/auth/me')
  assert.equal(joinBase('/wahl', '/api/auth/me'), '/wahl/api/auth/me')
  assert.equal(joinBase('/wahl', '/'), '/wahl/')
  assert.equal(stripBase('', '/wahlen/1'), '/wahlen/1')
  assert.equal(stripBase('/wahl', '/wahl/wahlen/1?tab=x'), '/wahlen/1?tab=x')
  assert.equal(stripBase('/wahl', '/wahl/'), '/')
  assert.equal(stripBase('/wahl', '/wahl'), '/')
  assert.equal(stripBase('/wahl', '/wahlen/1'), '/wahlen/1')
  assert.equal(stripBase('/wahl', '/wahl2/x'), '/wahl2/x')
})
