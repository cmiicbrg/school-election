#!/usr/bin/env node
// Fail the build if any package.json in the repository carries floating
// dependency ranges. Every dep must be pinned to an exact version;
// Dependabot is configured to land bumps as separate PRs.
//
// Checks the root package.json and every workspace it lists, because a
// floating range in apps/api or apps/web resolves just as silently as one
// at the root.
//
// Rejects: ^x.y.z, ~x.y.z, >=x.y.z, <x.y.z, *, x, latest, and any
// other range form the semver spec accepts. Accepts: x.y.z exact
// versions, file:/link: paths, http(s):// tarball URLs, npm: aliases and
// workspace: specifiers carrying an exact version (or workspace:*),
// and git specifiers pinned to a commit.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

export const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

// Exact semver only: no leading range operator (^ ~ < > =), no wildcard,
// no space-separated or ||-joined ranges.
const exactSemver = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/
// A git specifier is only immutable when it names a commit SHA. A bare
// URL or `#main` follows the branch; even `#v1.2.3` is a movable tag.
const gitCommit = /#[0-9a-f]{7,40}$/i
// `npm:pkg@range` / `npm:@scope/pkg@range` — capture the aliased range so
// it can be held to the same exact-version rule as an unaliased dep.
// Without this, `npm:pkg@^1.2.3` floats behind an accepted prefix.
const npmAlias = /^npm:@?[^@/]+(?:\/[^@/]+)?@(.+)$/
// `workspace:<range>` — every form resolves to the local package on install,
// but `workspace:^` / `workspace:~` are rewritten to a floating `^x.y.z` /
// `~x.y.z` when the package is published, so only `*` and an exact version
// are actually pinned.
const workspaceAlias = /^workspace:(.+)$/
// A plain https:// URL is not always a tarball. npm resolves a URL to a
// known git host's repository (`https://github.com/owner/repo.git#main`) as
// a git dependency, and a `.git` path or a `#committish` only makes sense for
// one. Those must name a commit like any other git specifier.
const hostedGitRepo = /^https?:\/\/(?:[^@/]+@)?(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|gist\.github\.com)\/[^/#]+(?:\/[^/#]+)?\/?(?:#|$)/i

export function isGitSpecifier(range) {
  // Explicit git URLs come in two shapes: bare `git:` (colon immediately
  // after) OR `git+ssh:`/`git+https:`/etc. (transport appended).
  if (/^git(\+[a-z]+)?:/.test(range)) return true
  if (!/^https?:/.test(range)) return false
  return hostedGitRepo.test(range) || /\.git(?:#|$)/.test(range) || range.includes('#')
}

export function isPinned(range) {
  if (isGitSpecifier(range)) return gitCommit.test(range)
  // Local paths and tarball URLs can't float: a tarball whose content
  // changes fails npm ci's integrity check instead of installing silently.
  if (/^(file|link|https?):/.test(range)) return true
  const workspace = workspaceAlias.exec(range)
  if (workspace) return workspace[1] === '*' || exactSemver.test(workspace[1])
  const alias = npmAlias.exec(range)
  if (alias) return exactSemver.test(alias[1])
  return exactSemver.test(range)
}

export function findFloats(pkg) {
  const floats = []
  for (const section of sections) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      if (!isPinned(range)) floats.push({ section, name, range })
    }
  }
  return floats
}

function readPackage(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

// Only run the check when invoked as a script, so the predicates above stay
// importable without side effects.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const rootPkg = readPackage(root)
  // Workspaces are listed as explicit paths, not globs, so this needs no
  // glob expansion; a glob entry would fail loudly here on the missing file.
  const dirs = ['.', ...(rootPkg.workspaces ?? [])]

  let failed = false
  for (const dir of dirs) {
    const floats = findFloats(dir === '.' ? rootPkg : readPackage(join(root, dir)))
    if (floats.length === 0) continue
    if (!failed) console.error('Floating dependency ranges found (project policy: pin everything):')
    failed = true
    for (const f of floats) {
      console.error(`  ${join(dir, 'package.json')} ${f.section} > ${f.name}: ${f.range}`)
    }
  }

  if (failed) {
    console.error('\nReplace with exact versions; Dependabot will land bumps.')
    process.exit(1)
  }

  console.log(`All dependencies pinned in ${dirs.length} package.json files ✓`)
}
