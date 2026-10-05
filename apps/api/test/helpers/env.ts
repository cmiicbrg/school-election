import { randomBytes } from 'node:crypto'
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

/** The origin the tests' app is configured with. */
export const ORIGIN = 'https://wahl.example.org'

export const TENANT_ID = '3f2b8c1d-6e4a-4b7f-9c2d-8a1e5f6b7c90'
export const CLIENT_ID = 'a7c3e9f1-2b4d-4e6f-8a0b-1c3d5e7f9a2b'
export const CLIENT_SECRET = 'test~client.secret_value'

/** The sign-in and session settings every server configuration needs. */
export const AUTH_ENV = {
  ENTRA_TENANT_ID: TENANT_ID,
  ENTRA_CLIENT_ID: CLIENT_ID,
  ENTRA_CLIENT_SECRET_FILE: secretFile('entra-client-secret', `${CLIENT_SECRET}\n`),
  SESSION_KEY_FILE: secretFile('session-key', `${randomBytes(32).toString('hex')}\n`),
}

/** Everything a server needs besides PUBLIC_URL. */
export const SERVER_ENV = { ...DB_ENV, ...AUTH_ENV }
