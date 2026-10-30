import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findFloats, isPinned, unpinnedBuildkit, unpinnedSyntax } from './lint-deps.mjs'

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

const digest = `sha256:${'0123456789abcdef'.repeat(4)}`

test('a Dockerfile frontend must name a digest, and only a directive at the top counts', () => {
  assert.equal(unpinnedSyntax('# syntax=docker/dockerfile:1.7\n#\n# The image.\nFROM node'), 'docker/dockerfile:1.7')
  assert.equal(unpinnedSyntax('# check=skip=all\n# SYNTAX = docker/dockerfile:1\nFROM node'), 'docker/dockerfile:1', 'any directive in the run, in any case')
  assert.equal(unpinnedSyntax(`# syntax=docker/dockerfile:1.7@${digest}\nFROM node`), undefined)
  assert.equal(unpinnedSyntax('# The image.\nFROM node'), undefined, 'no directive')
  assert.equal(unpinnedSyntax('# The image.\n# syntax=docker/dockerfile:1.7\nFROM node'), undefined, 'after a comment it is a comment')
  assert.equal(unpinnedSyntax('\n# syntax=docker/dockerfile:1.7\nFROM node'), undefined, 'after a blank line it is a comment')
})

test('every buildx setup must run BuildKit from an image with a digest', () => {
  const steps = (...lines) => ['jobs:', '  image:', '    steps:', ...lines, '      - uses: docker/build-push-action@abc # v7', '        with:', '          push: false'].join('\n')
  const setup = '      - uses: docker/setup-buildx-action@abc # v4'
  assert.deepEqual(unpinnedBuildkit(steps(setup)), [4], 'the default image, a tag')
  assert.deepEqual(unpinnedBuildkit(steps(setup, '        with:', '          driver-opts: image=moby/buildkit:v0.33.1')), [4], 'a tag alone')
  assert.deepEqual(unpinnedBuildkit(steps(setup, '        with:', `          driver-opts: image=moby/buildkit:v0.33.1@${digest}`)), [])
  assert.deepEqual(unpinnedBuildkit(steps(setup, '        with:', '          driver-opts: |', `            image=moby/buildkit:v0.33.1@${digest}`, '            network=host')), [], 'a list of options')
  assert.deepEqual(unpinnedBuildkit(steps('      - name: Buildx', '        uses: docker/setup-buildx-action@abc # v4', '        with:', `          driver-opts: image=moby/buildkit@${digest}`)), [], 'uses: below a name')
  assert.deepEqual(unpinnedBuildkit(steps('      - name: Buildx', '        uses: docker/setup-buildx-action@abc # v4')), [5])
  assert.deepEqual(unpinnedBuildkit(steps(setup, '', '      # A comment.', '      - uses: docker/metadata-action@abc', '        with:', `          driver-opts: image=moby/buildkit@${digest}`)), [4], 'a pin in the next step does not count')
  assert.deepEqual(unpinnedBuildkit(steps('      - uses: docker/build-push-action@abc')), [], 'no buildx setup')
})
