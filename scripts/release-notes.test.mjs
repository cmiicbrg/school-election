import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArgs, releaseNotes } from './release-notes.mjs'

const images = {
  app: 'ghcr.io/cmiicbrg/school-election:v1.2.0@sha256:aaaa',
  postgres: 'ghcr.io/cmiicbrg/school-election-postgres:v1.2.0@sha256:bbbb',
}
const base = {
  tag: 'v1.2.0',
  previous: 'v1.1.0',
  images,
  line: 'v1',
  migrations: ['0001_baseline.sql', '0002_lead_transfer.sql'],
  previousMigrations: ['0001_baseline.sql', '0002_lead_transfer.sql'],
  repositoryUrl: 'https://github.com/cmiicbrg/school-election',
}

test('a release without migrations: both images, the nightly pickup, the way back open, both verify lines', () => {
  const notes = releaseNotes(base)
  assert.match(notes, /^## What a host pulls\n\n```\n.*school-election:v1\.2\.0@sha256:aaaa\n.*-postgres:v1\.2\.0@sha256:bbbb\n```\n/)
  assert.match(notes, /Deployments following the `v1` line pick this release up with their next nightly update, never while a round accepts ballots \(\[Updates\]\(https:\/\/github\.com\/cmiicbrg\/school-election\/blob\/v1\.2\.0\/deploy\/README\.md#updates\)\)\./)
  assert.match(notes, /No migration since v1\.1\.0: a host can go back to v1\.1\.0 on the same database\./)
  assert.match(notes, /cosign verify --key deploy\/cosign\.pub ghcr\.io\/cmiicbrg\/school-election:v1\.2\.0@sha256:aaaa\n/)
  assert.match(notes, /cosign verify --key deploy\/cosign\.pub ghcr\.io\/cmiicbrg\/school-election-postgres:v1\.2\.0@sha256:bbbb\n/)
  assert.match(notes, /blob\/v1\.2\.0\/deploy\/cosign\.pub/)
  assert.doesNotMatch(notes, /New since|first release/)
})

test('new migrations are named, with the backup as the way back', () => {
  const notes = releaseNotes({ ...base, migrations: [...base.migrations, '0003_session_binding.sql', '0004_node_26_13_1.sql'] })
  assert.match(notes, /New since v1\.1\.0: `0003_session_binding\.sql`, `0004_node_26_13_1\.sql`\. The migrator of an earlier release refuses a database this release has migrated, so a host does not go back behind it; the way back is the backup taken before the update \(\[Updates\]\(https:\/\/github\.com\/cmiicbrg\/school-election\/blob\/v1\.2\.0\/deploy\/README\.md#updates\)\)\./)
  assert.doesNotMatch(notes, /No migration/)
})

test('the first release names its migrations and has no previous one to compare with', () => {
  const notes = releaseNotes({ ...base, tag: 'v1.0.0', previous: '', migrations: ['0001_baseline.sql'], previousMigrations: [] })
  assert.match(notes, /The first release, with `0001_baseline\.sql`\./)
})

const argv = [
  '--tag=v1.2.0',
  '--previous=v1.1.0',
  `--app=${images.app}`,
  `--postgres=${images.postgres}`,
  '--line=v1',
  '--migrations=0001_baseline.sql,0002_lead_transfer.sql',
  '--previous-migrations=0001_baseline.sql,0002_lead_transfer.sql',
  '--repository=https://github.com/cmiicbrg/school-election',
]
const replace = (from, to) => argv.map((arg) => (arg === from ? to : arg))

test('the command line names every value once; the migrations become lists, an empty previous list none', () => {
  assert.deepEqual(parseArgs(argv), base)
  assert.deepEqual(
    parseArgs(replace('--previous=v1.1.0', '--previous=').map((arg) => (arg.startsWith('--previous-migrations=') ? '--previous-migrations=' : arg))),
    { ...base, previous: '', previousMigrations: [] },
  )
})

test('a missing, repeated, unknown or malformed argument is refused with its name', () => {
  assert.throws(() => parseArgs(argv.filter((arg) => !arg.startsWith('--postgres='))), /Missing: --postgres/)
  assert.throws(() => parseArgs([...argv, '--tag=v9.9.9']), /Given twice: --tag/)
  assert.throws(() => parseArgs([...argv, '--latest=yes']), /Unexpected argument: --latest=yes/)
  assert.throws(() => parseArgs([...argv, 'v1.2.0']), /Unexpected argument: v1\.2\.0/)
  assert.throws(() => parseArgs(replace('--migrations=0001_baseline.sql,0002_lead_transfer.sql', '--migrations=0001_baseline.sql,README.md')), /--migrations: not a migration file name: README\.md/)
  assert.throws(() => parseArgs(replace('--migrations=0001_baseline.sql,0002_lead_transfer.sql', '--migrations=')), /--migrations names no migration/)
})

test('the previous migrations come with a previous release, and none of them goes missing', () => {
  assert.throws(() => parseArgs(replace('--previous=v1.1.0', '--previous=')), /--previous-migrations without --previous/)
  assert.throws(() => parseArgs(argv.map((arg) => (arg.startsWith('--previous-migrations=') ? '--previous-migrations=' : arg))), /--previous-migrations names no migration/)
  assert.throws(() => parseArgs(replace('--migrations=0001_baseline.sql,0002_lead_transfer.sql', '--migrations=0001_baseline.sql')), /Migrations of v1\.1\.0 missing from v1\.2\.0: 0002_lead_transfer\.sql/)
})
