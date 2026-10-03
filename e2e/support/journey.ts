// What one spec hands to the next: the ids the pages gave the journey's
// election and batches. Kept in a file under the output directory, which
// Playwright empties at the start of a run, so every run starts afresh
// and a spec that runs on its own says what it is missing.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const FILE = path.join('test-results', 'journey.json')

export interface Journey {
  electionId?: string
  title?: string
  /** Batch ids by class and round, e.g. "1A regular". */
  batches?: Record<string, string>
  /** The first key of the first batch printed, normalised. */
  firstKey?: string
}

export function journey(): Journey {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Journey
  } catch {
    return {}
  }
}

export function remember(patch: Partial<Journey>): void {
  mkdirSync(path.dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify({ ...journey(), ...patch }, null, 2))
}

/** The journey's election, which an earlier spec created. */
export function electionId(): string {
  const id = journey().electionId
  if (!id) throw new Error('no election yet: the specs build on each other, run them in order')
  return id
}

export function batchId(name: string): string {
  const id = journey().batches?.[name]
  if (!id) throw new Error(`no batch "${name}" yet: the specs build on each other, run them in order`)
  return id
}
