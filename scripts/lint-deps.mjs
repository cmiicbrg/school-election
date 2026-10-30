#!/usr/bin/env node
// Fail the build if anything the repository builds with floats: a
// dependency range in a package.json, a Dockerfile frontend (`# syntax=`)
// or the BuildKit image a workflow builds with, named without a digest.
// Every dep must be pinned to an exact version; Dependabot is configured
// to land bumps as separate PRs.
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

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

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

// BuildKit runs the image builds and the frontend a Dockerfile names
// reads it, so both decide what gets signed; a tag can be moved under a
// release, a digest cannot.
const digest = /@sha256:[0-9a-f]{64}$/
// A parser directive: `# key=value` in the leading comments of a
// Dockerfile; whitespace before the `#` is ignored, as for any comment.
// BuildKit takes a syntax directive's first word as the frontend's image
// and passes the rest to it, so the first word is the one to check.
const directive = /^\s*#\s*([a-z]+)\s*=\s*(\S+)(?:\s.*)?$/i

/** The frontend a Dockerfile's `# syntax=` directive names without a digest, or undefined. */
export function unpinnedSyntax(dockerfile) {
  // Directives count only at the very top: the first line that is not one
  // (a comment, a blank line, an instruction) ends them.
  for (const line of dockerfile.split(/\r?\n/)) {
    const match = directive.exec(line)
    if (!match) return undefined
    if (match[1].toLowerCase() === 'syntax' && !digest.test(match[2])) return match[2]
  }
  return undefined
}

/** The line numbers of a workflow's docker/setup-buildx-action steps that run BuildKit from an image without a digest. */
export function unpinnedBuildkit(workflow) {
  const lines = workflow.split(/\r?\n/)
  const indentOf = (line) => line.search(/\S/)
  const unpinned = []
  lines.forEach((line, index) => {
    // YAML takes any whitespace after a sequence's dash.
    if (!/^\s*(?:-\s+)?uses:\s*['"]?docker\/setup-buildx-action@/.test(line)) return
    // The step is the list item holding this line: from its dash to the
    // next line indented no deeper than that dash.
    let start = index
    while (start > 0 && !/^\s*-\s/.test(lines[start])) start -= 1
    const dash = indentOf(lines[start])
    let end = start + 1
    while (end < lines.length && (indentOf(lines[end]) === -1 || indentOf(lines[end]) > dash)) end += 1
    // Comments say nothing about what runs: an old pin in one must not pass.
    const step = lines.slice(start, end).map((text) => text.replace(/(^|\s)#.*$/, '$1'))
    if (!/(?:^|[\s,'"])image=\S+@sha256:[0-9a-f]{64}\b/.test(driverOpts(step))) unpinned.push(index + 1)
  })
  return unpinned
}

/** The value of a step's `driver-opts` input, inline or as a block below the key; empty without one. */
function driverOpts(step) {
  const key = step.findIndex((text) => /^\s*driver-opts:/.test(text))
  if (key === -1) return ''
  const indent = step[key].search(/\S/)
  const block = []
  for (const text of step.slice(key + 1)) {
    const at = text.search(/\S/)
    if (at !== -1 && at <= indent) break
    block.push(text)
  }
  return [step[key].replace(/^\s*driver-opts:/, ''), ...block].join('\n')
}

/** Every Dockerfile below `dir`, hidden directories included, skipping git's own, dependencies and build output. */
export function dockerfiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return ['.git', 'node_modules', 'dist', 'coverage'].includes(entry.name) ? [] : dockerfiles(path)
    return /^Dockerfile(?:\..+)?$|\.Dockerfile$/.test(entry.name) ? [path] : []
  })
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
  if (failed) console.error('\nReplace with exact versions; Dependabot will land bumps.')

  const files = dockerfiles(root)
  const workflowsDir = join(root, '.github', 'workflows')
  const workflows = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name)).map((name) => join(workflowsDir, name))
  const builds = [
    ...files.flatMap((file) => {
      const frontend = unpinnedSyntax(readFileSync(file, 'utf8'))
      return frontend === undefined ? [] : [`  ${relative(root, file)}: # syntax=${frontend}`]
    }),
    ...workflows.flatMap((file) => unpinnedBuildkit(readFileSync(file, 'utf8')).map((line) => `  ${relative(root, file)}:${line}: docker/setup-buildx-action without driver-opts: image=<image>@sha256:<digest>`)),
  ]
  if (builds.length > 0) {
    console.error(`${failed ? '\n' : ''}Build inputs named without a digest (project policy: pin everything):`)
    for (const entry of builds) console.error(entry)
    console.error('\nName BuildKit by tag and digest; leave the Dockerfile frontend to the built-in one, or pin it by digest.')
    failed = true
  }

  if (failed) process.exit(1)

  console.log(`All dependencies pinned in ${dirs.length} package.json files, ${files.length} Dockerfiles and ${workflows.length} workflows ✓`)
}
