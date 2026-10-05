// The PostgreSQL settings the app requires are written down three times: in
// the startup check (lib/db-settings.ts), in the launcher that development
// and CI use (scripts/postgres.sh) and in the command of the deployment's
// PostgreSQL image (deploy/postgres/Dockerfile). These tests fail as soon
// as they disagree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWED_SETTINGS, REQUIRED_SETTINGS } from '../lib/db-settings.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LAUNCHER = 'scripts/postgres.sh'
const DOCKERFILE = 'deploy/postgres/Dockerfile'

const read = (file: string) => readFile(path.join(root, file), 'utf8')

/**
 * Every setting on a line of its own, in order: `-c name=value` and the
 * `--name=value` form PostgreSQL also accepts in the launcher, and
 * `"-c", "name=value"` in the Dockerfile's exec-form command. Any name
 * counts, including a module's dotted ones, so a setting the check does
 * not know is caught.
 */
async function flags(file: string): Promise<[string, string][]> {
  const text = await read(file)
  const shell = [...text.matchAll(/^\s*(?:-c |--)([^=\s]+)=(\S*)$/gm)]
  const exec = [...text.matchAll(/^\s*"-c", "([^="]+)=([^"]*)"[,\]]? ?\\?$/gm)]
  return [...shell, ...exec].map((match) => [match[1] ?? '', match[2] ?? ''])
}

for (const file of [LAUNCHER, DOCKERFILE]) {
  test(`${file} sets every setting the startup check requires, and no other`, async () => {
    const list = await flags(file)
    const set = new Map(list)
    assert.equal(set.size, list.length, 'a setting is given twice')
    for (const { name, expected } of REQUIRED_SETTINGS) assert.equal(set.get(name), expected, name)
    for (const { name, allowed } of ALLOWED_SETTINGS) {
      const entries = set.get(name)?.split(',') ?? []
      assert.ok(entries.length > 0 && entries.every((entry) => allowed.includes(entry)), name)
    }
    const known = new Set([...REQUIRED_SETTINGS, ...ALLOWED_SETTINGS].map((setting) => setting.name))
    assert.deepEqual(list.map(([name]) => name).filter((name) => !known.has(name)), [])
  })
}

test('development, CI and the deployment image start PostgreSQL with the same flags', async () => {
  assert.deepEqual(await flags(DOCKERFILE), await flags(LAUNCHER))
})

test('the launcher starts the image the deployment is built from', async () => {
  const pinned = /^FROM (docker\.io\/library\/postgres:\S+@sha256:[0-9a-f]{64})$/m.exec(await read(DOCKERFILE))?.[1]
  assert.ok(pinned, 'the Dockerfile pins the image by tag and digest')
  assert.match(await read(LAUNCHER), /deploy\/postgres\/Dockerfile/)
})

test('CI starts PostgreSQL through the launcher or the deployment image, never with flags of its own', async () => {
  const ci = await read('.github/workflows/ci.yml')
  assert.match(ci, /scripts\/postgres\.sh /)
  assert.doesNotMatch(ci, /library\/postgres|-c [a-z_]+=/)
})
