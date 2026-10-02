import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const secrets = mkdtempSync(path.join(tmpdir(), 'school-election-secrets-'))

/** Writes a secret file for a test and returns its path. */
export function secretFile(name: string, content: string): string {
  const file = path.join(secrets, name)
  writeFileSync(file, content)
  return file
}

/** The database settings every server configuration needs. */
export const DB_ENV = {
  DATABASE_URL: 'postgres://school_election_app@127.0.0.1:5432/school_election',
  DATABASE_PASSWORD_FILE: secretFile('db-password', 'test-password\n'),
}
