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
})

test('under a base path, a return path stays below it, and the fallback is the app\'s start page', () => {
  for (const path of ['/wahl', '/wahl/', '/wahl/wahlen/42?tab=open']) {
    assert.equal(safeReturnTo(path, '/wahl'), path)
  }
  for (const value of ['/', '/admin', '/wahlen', '/wahl2/x', '/wahl/api', '/wahl/api/auth/logout', '//evil.example', '/wahl/v#key', undefined]) {
    assert.equal(safeReturnTo(value, '/wahl'), '/wahl/', JSON.stringify(value))
  }
})
