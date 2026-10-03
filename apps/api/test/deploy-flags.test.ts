// The PostgreSQL settings the app requires are written down three times: in
// the startup check (lib/db-settings.ts), in the launcher that development
// and CI use (scripts/postgres.sh) and in the deployment example
// (deploy/compose.example.yml). These tests fail as soon as they disagree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWED_SETTINGS, REQUIRED_SETTINGS } from '../lib/db-settings.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LAUNCHER = 'scripts/postgres.sh'
const COMPOSE = 'deploy/compose.example.yml'

const read = (file: string) => readFile(path.join(root, file), 'utf8')

/** Every `-c name=value` that stands on a line of its own, in order. */
async function flags(file: string): Promise<[string, string][]> {
  return [...(await read(file)).matchAll(/^\s*-c ([a-z_]+)=(\S+)$/gm)].map((match) => [match[1] ?? '', match[2] ?? ''])
}

for (const file of [LAUNCHER, COMPOSE]) {
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

test('development, CI and the deployment example start PostgreSQL with the same flags', async () => {
  assert.deepEqual(await flags(COMPOSE), await flags(LAUNCHER))
})

test('CI starts PostgreSQL only through the launcher', async () => {
  const ci = await read('.github/workflows/ci.yml')
  assert.match(ci, /scripts\/postgres\.sh /)
  assert.doesNotMatch(ci, /library\/postgres|-c [a-z_]+=/)
})
