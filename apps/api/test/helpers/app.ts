import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { buildApp, type AppOptions } from '../../app.ts'
import { loadConfig } from '../../config.ts'
import type { Database } from '../../lib/db.ts'
import { ORIGIN, SERVER_ENV } from './env.ts'

export { ORIGIN }

export interface TestApp {
  app: FastifyInstance
  /** Every log line written so far, raw. */
  logs: () => string
}

/** A database that answers every query with one empty row; for tests that do not touch data. */
export function stubDatabase(query: Database['query'] = () => Promise.resolve({ rows: [{}] }) as never): Database {
  return { query, tx: async (fn) => fn({ query } as never), close: async () => {} }
}

/**
 * The app as production builds it, from an environment, with log output
 * captured. Routes can still be added before the first inject().
 */
export async function buildTestApp(env: Record<string, string> = {}, db: Database = stubDatabase(), options: Pick<AppOptions, 'entraAuthority' | 'onRoute' | 'voter'> = {}): Promise<TestApp> {
  let captured = ''
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      captured += chunk.toString()
      done()
    },
  })
  const config = loadConfig({ ...SERVER_ENV, PUBLIC_ORIGIN: ORIGIN, WEB_DIST_DIR: path.join(tmpdir(), 'no-web-build-here'), ...env })
  const app = await buildApp(config, { db, logStream, ...options })
  return { app, logs: () => captured }
}

/** A throwaway web build containing only index.html. */
export function fakeWebDist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'school-election-web-'))
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>')
  return dir
}
