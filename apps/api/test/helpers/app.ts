import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../app.ts'
import { loadConfig } from '../../config.ts'

export const ORIGIN = 'https://wahl.example.org'

export interface TestApp {
  app: FastifyInstance
  /** Every log line written so far, raw. */
  logs: () => string
}

/**
 * The app as production builds it, from an environment, with log output
 * captured. Routes can still be added before the first inject().
 */
export async function buildTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  let captured = ''
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      captured += chunk.toString()
      done()
    },
  })
  const config = loadConfig({ PUBLIC_ORIGIN: ORIGIN, WEB_DIST_DIR: path.join(tmpdir(), 'no-web-build-here'), ...env })
  const app = await buildApp(config, { logStream })
  return { app, logs: () => captured }
}

/** A throwaway web build containing only index.html. */
export function fakeWebDist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'school-election-web-'))
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>')
  return dir
}
