import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeReturnTo } from '../lib/return-to.ts'

test('a return path stays on this site', () => {
  for (const path of ['/', '/admin', '/admin/elections/42?tab=open', '/a/b%2Fc']) {
    assert.equal(safeReturnTo(path), path)
  }
})

test('anything that could leave the site, or is not a page, falls back', () => {
  const refused = [
    undefined, null, 42, ['/admin'], '',
    'admin', 'https://evil.example/', 'http:/evil.example', 'javascript:alert(1)', 'data:text/html,x',
    '//evil.example', '///evil.example', '/\\evil.example', '\\\\evil.example',
    '/\t/evil.example', '/\n/evil.example', '/ /x', '/admin\u0000', '/ädmin',
    '/admin#fragment', '/vote#key=ABCD',
    '/api', '/api/auth/logout', '/api/../api/x',
  ]
  for (const value of refused) assert.equal(safeReturnTo(value), '/', JSON.stringify(value))
  assert.equal(safeReturnTo('//evil.example', '/admin'), '/admin')
})
