#!/usr/bin/env node
// The head of a release's notes, written by the publish workflow once the
// release's images are verified and tagged (.github/workflows/publish-image.yml,
// the `release` job): what a host pulls, with the digests; whether the line
// moved to it; the migrations new since the previous release, which decide
// whether a host can go back to it; how to verify an image. GitHub's
// generated notes (the pull requests merged since the previous release)
// follow it.
//
// Usage: node scripts/release-notes.mjs --tag=v1.2.0 --previous=v1.1.0 --app=<image ref> --postgres=<image ref>
//   --line=v1 --line-moved=yes|no --line-current=<tag> --migrations=<files> --previous-migrations=<files>
//   --repository=<url>
// An image ref is `image:tag@sha256:…`, as the step summary writes it. The migrations are the file
// names in apps/api/migrations at each tag, comma-separated. `line-current` is the release the line
// carried before; it, `previous` and `previous-migrations` are empty for a first release.

import { fileURLToPath } from 'node:url'

/** The notes above GitHub's generated part, as Markdown. */
export function releaseNotes({ tag, previous, images, line, lineMoved, lineCurrent, migrations, previousMigrations, repositoryUrl }) {
  const guide = (anchor) => `${repositoryUrl}/blob/${tag}/deploy/README.md#${anchor}`
  // The first release of a major line: no host follows it yet, and the way back to the line before
  // is never the same database, since a PostgreSQL major comes only with an app major.
  const newMajor = previous !== '' && major(previous) !== major(tag)
  return [
    '## What a host pulls',
    '',
    '```',
    images.app,
    images.postgres,
    '```',
    '',
    lineSentence({ tag, previous, line, lineMoved, lineCurrent, newMajor, updatesUrl: guide('updates') }),
    '',
    '## Migrations',
    '',
    migrationLine({ previous, newMajor, migrations, previousMigrations, updatesUrl: guide('updates') }),
    '',
    '## Verify',
    '',
    '```',
    `cosign verify --key deploy/cosign.pub ${images.app}`,
    `cosign verify --key deploy/cosign.pub ${images.postgres}`,
    '```',
    '',
    `A host's policy (\`deploy/policy.json\`) checks the same signature on every pull; the key is [\`deploy/cosign.pub\`](${repositoryUrl}/blob/${tag}/deploy/cosign.pub).`,
  ].join('\n')
}

const code = (names) => names.map((name) => `\`${name}\``).join(', ')
const major = (tag) => tag.split('.')[0]

function lineSentence({ tag, previous, line, lineMoved, lineCurrent, newMajor, updatesUrl }) {
  if (!lineMoved) return `The \`${line}\` line stays on ${lineCurrent}, which is newer; a host runs this release only with \`${tag}\` in place of \`${line}\` in its unit files.`
  if (newMajor) return `The first release of the \`${line}\` line. Deployments following \`${major(previous)}\` stay on it: a major is the one update done by hand ([Updates](${updatesUrl})).`
  return `Deployments following the \`${line}\` line pick this release up with their next nightly update, never while a round accepts ballots ([Updates](${updatesUrl})).`
}

function migrationLine({ previous, newMajor, migrations, previousMigrations, updatesUrl }) {
  if (previous === '') return `The first release, with ${code(migrations)}.`
  const added = migrations.filter((name) => !previousMigrations.includes(name))
  if (added.length === 0 && newMajor) return `No migration since ${previous}, but a new major: the way back to ${previous} is the backup taken before the update ([Updates](${updatesUrl})).`
  if (added.length === 0) return `No migration since ${previous}: a host can go back to ${previous} on the same database.`
  return `New since ${previous}: ${code(added)}. The migrator of an earlier release refuses a database this release has migrated, so a host does not go back behind it; the way back is the backup taken before the update ([Updates](${updatesUrl})).`
}

const FLAGS = new Set(['tag', 'previous', 'app', 'postgres', 'line', 'line-moved', 'line-current', 'migrations', 'previous-migrations', 'repository'])
const MIGRATION = /^\d{4}_[a-z0-9_]+\.sql$/

/** A comma-separated list of migration file names; every name as the migrator's directory holds them. */
function migrationList(flag, value) {
  if (value === '') return []
  const names = value.split(',')
  for (const name of names) if (!MIGRATION.test(name)) throw new Error(`--${flag}: not a migration file name: ${name}`)
  return names
}

/** The command line's `--flag=value` pairs, every flag given once; a stray argument or a missing flag is refused. */
export function parseArgs(argv) {
  const values = {}
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/s.exec(arg)
    if (match === null || !FLAGS.has(match[1])) throw new Error(`Unexpected argument: ${arg}`)
    if (Object.hasOwn(values, match[1])) throw new Error(`Given twice: --${match[1]}`)
    values[match[1]] = match[2]
  }
  for (const flag of FLAGS) if (!Object.hasOwn(values, flag)) throw new Error(`Missing: --${flag}`)
  if (!['yes', 'no'].includes(values['line-moved'])) throw new Error('--line-moved must be yes or no')
  if (values['line-moved'] === 'no' && values['line-current'] === '') throw new Error('--line-current names the release the line stays on')
  const migrations = migrationList('migrations', values.migrations)
  const previousMigrations = migrationList('previous-migrations', values['previous-migrations'])
  if (migrations.length === 0) throw new Error('--migrations names no migration')
  if (values.previous === '' && previousMigrations.length > 0) throw new Error('--previous-migrations without --previous')
  if (values.previous !== '' && previousMigrations.length === 0) throw new Error('--previous-migrations names no migration')
  // Migrations only go forward: one that the previous release had and this one lacks is a mistake upstream.
  const dropped = previousMigrations.filter((name) => !migrations.includes(name))
  if (dropped.length > 0) throw new Error(`Migrations of ${values.previous} missing from ${values.tag}: ${dropped.join(', ')}`)
  return {
    tag: values.tag,
    previous: values.previous,
    images: { app: values.app, postgres: values.postgres },
    line: values.line,
    lineMoved: values['line-moved'] === 'yes',
    lineCurrent: values['line-current'],
    migrations,
    previousMigrations,
    repositoryUrl: values.repository,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${releaseNotes(parseArgs(process.argv.slice(2)))}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
