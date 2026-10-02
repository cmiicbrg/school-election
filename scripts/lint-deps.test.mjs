import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findFloats, isPinned } from './lint-deps.mjs'

const sha = '0123456789abcdef0123456789abcdef01234567'

test('exact versions are pinned, ranges are not', () => {
  for (const range of ['1.2.3', '1.2.3-beta.1', '1.2.3+build.5']) assert.equal(isPinned(range), true, range)
  for (const range of ['^1.2.3', '~1.2.3', '>=1.2.3', '1.x', '*', 'latest', '1.2.3 || 2.0.0']) {
    assert.equal(isPinned(range), false, range)
  }
})

test('git URLs must name a commit', () => {
  for (const range of [
    `git+https://github.com/example/pkg.git#${sha}`,
    `git+ssh://git@github.com/example/pkg.git#${sha.slice(0, 7)}`,
    `git://example.com/pkg.git#${sha}`,
  ]) assert.equal(isPinned(range), true, range)
  for (const range of [
    'git+https://github.com/example/pkg.git',
    'git+https://github.com/example/pkg.git#main',
    'git+https://github.com/example/pkg.git#v1.2.3',
  ]) assert.equal(isPinned(range), false, range)
})

test('https URLs that npm resolves as git repositories must name a commit', () => {
  for (const range of [
    'https://github.com/example/pkg.git#main',
    'https://github.com/example/pkg#main',
    'https://github.com/example/pkg',
    'https://gitlab.com/example/pkg.git',
    'https://git.example.com/pkg.git',
    'https://example.com/pkg.tgz#main',
  ]) assert.equal(isPinned(range), false, range)
  for (const range of [
    `https://github.com/example/pkg.git#${sha}`,
    `https://git.example.com/pkg.git#${sha}`,
  ]) assert.equal(isPinned(range), true, range)
})

test('tarball URLs and local paths are accepted', () => {
  for (const range of [
    'https://registry.example.com/pkg/-/pkg-1.2.3.tgz',
    'https://github.com/example/pkg/archive/0123456.tar.gz',
    'file:../pkg',
    'link:../pkg',
  ]) assert.equal(isPinned(range), true, range)
})

test('npm and workspace aliases are held to the exact-version rule', () => {
  assert.equal(isPinned('npm:pkg@1.2.3'), true)
  assert.equal(isPinned('npm:@scope/pkg@1.2.3'), true)
  assert.equal(isPinned('npm:pkg@^1.2.3'), false)
  assert.equal(isPinned('workspace:*'), true)
  assert.equal(isPinned('workspace:1.2.3'), true)
  assert.equal(isPinned('workspace:^'), false)
})

test('findFloats reports every floating entry with its section', () => {
  assert.deepEqual(
    findFloats({
      dependencies: { a: '1.0.0', b: 'https://github.com/example/b.git#main' },
      devDependencies: { c: '^2.0.0' },
    }),
    [
      { section: 'dependencies', name: 'b', range: 'https://github.com/example/b.git#main' },
      { section: 'devDependencies', name: 'c', range: '^2.0.0' },
    ],
  )
})
