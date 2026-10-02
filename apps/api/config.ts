// Startup configuration: read from the environment once, validated before
// anything listens. A missing or unsafe value stops the process with one
// message that names every problem, instead of booting half-configured.
//
// No check here reads NODE_ENV. A safety rule that an environment variable
// can switch off is one a wrong deployment setting switches off.

import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Config {
  host: string
  port: number
  /** The origin browsers use, e.g. https://wahl.example.org. */
  publicOrigin: string
  /** Addresses and CIDRs of the proxies whose X-Forwarded-* headers count. */
  trustProxy: string[]
  logLevel: LogLevel
  webDistDir: string
  /** Runtime connection, as the unprivileged role, password included. */
  databaseUrl: string
}

export interface MigrationConfig {
  /** Owner connection, password included. Never given to the server. */
  databaseUrl: string
  /** Password the migrator sets on the runtime role. */
  runtimePassword: string
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

export class ConfigError extends Error {
  override name = 'ConfigError'
}

type Env = Record<string, string | undefined>

const here = path.dirname(fileURLToPath(import.meta.url))
const loopbackOnly = ['127.0.0.0/8', '::1/128']

export function loadConfig(env: Env): Config {
  const problems: string[] = []
  const check = <T>(parse: () => T, fallback: T): T => {
    try {
      return parse()
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err
      problems.push(err.message)
      return fallback
    }
  }

  const publicOrigin = check(() => parsePublicOrigin(env.PUBLIC_ORIGIN), undefined)
  const host = env.HOST?.trim() || '127.0.0.1'
  const local = (publicOrigin?.loopback ?? false) && isLoopbackHost(host)
  const config: Config = {
    host,
    port: check(() => parsePort(env.PORT), 0),
    publicOrigin: publicOrigin?.origin ?? '',
    trustProxy: check(() => parseTrustProxy(env.TRUST_PROXY), []),
    logLevel: check(() => parseLogLevel(env.LOG_LEVEL, local), 'info'),
    webDistDir: env.WEB_DIST_DIR?.trim() || path.resolve(here, '..', 'web', 'dist'),
    databaseUrl: check(() => databaseUrl(env, 'DATABASE_URL', 'DATABASE_PASSWORD'), ''),
  }

  throwIfAny(problems)
  return config
}

/** What the migrator needs; the server never reads these variables. */
export function loadMigrationConfig(env: Env): MigrationConfig {
  const problems: string[] = []
  const check = (parse: () => string): string => {
    try {
      return parse()
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err
      problems.push(err.message)
      return ''
    }
  }
  const config = {
    databaseUrl: check(() => databaseUrl(env, 'MIGRATION_DATABASE_URL', 'MIGRATION_DATABASE_PASSWORD')),
    runtimePassword: check(() => readSecret(env, 'DB_RUNTIME_PASSWORD')),
  }
  throwIfAny(problems)
  return config
}

function throwIfAny(problems: string[]): void {
  if (problems.length === 0) return
  const list = problems.map((problem) => '  - ' + problem).join('\n')
  throw new ConfigError(`invalid configuration:\n${list}`)
}

// A postgres:// URL without a password, plus the password from its secret
// file. A password written into the URL would end up wherever the variable
// is visible, so it is refused.
function databaseUrl(env: Env, urlName: string, secretName: string): string {
  const raw = env[urlName]?.trim()
  if (!raw) throw new ConfigError(`${urlName} must be set, e.g. postgres://user@host:5432/database`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`${urlName} is not a URL`)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ConfigError(`${urlName} must be a postgres:// URL`)
  }
  if (url.password !== '') {
    throw new ConfigError(`${urlName} must not contain a password; set ${secretName}_FILE instead`)
  }
  if (url.username === '' || url.pathname.length <= 1) {
    throw new ConfigError(`${urlName} must name a user and a database`)
  }
  // Encoded explicitly: the URL setter leaves '%' as it is, so a password
  // containing one would be decoded into something else on connect.
  url.password = encodeURIComponent(readSecret(env, secretName))
  return url.toString()
}

/**
 * A secret is read from the file named by `<NAME>_FILE`, never from `<NAME>`
 * itself: environment values show up in `podman inspect`, process listings
 * and crash dumps, while a read-only mounted file does not. Setting the
 * inline variable is an error rather than something silently ignored.
 */
export function readSecret(env: Env, name: string, readFile = (file: string) => readFileSync(file, 'utf8')): string {
  if (env[name] !== undefined) {
    throw new ConfigError(`${name} must not be set; put the secret in a file and set ${name}_FILE to its path`)
  }
  const file = env[`${name}_FILE`]?.trim()
  if (!file) throw new ConfigError(`${name}_FILE must be set`)
  let value: string
  try {
    value = readFile(file)
  } catch {
    throw new ConfigError(`${name}_FILE: cannot read ${file}`)
  }
  value = value.trim()
  if (value === '') throw new ConfigError(`${name}_FILE: ${file} is empty`)
  return value
}

function parsePublicOrigin(raw: string | undefined): { origin: string, loopback: boolean } {
  const value = raw?.trim()
  if (!value) throw new ConfigError('PUBLIC_ORIGIN must be set, e.g. https://wahl.example.org')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`PUBLIC_ORIGIN is not a URL: ${value}`)
  }
  // An origin only: anything after it would make the CSRF comparison and
  // every generated link ambiguous.
  if (url.origin === 'null' || `${url.origin}/` !== url.href) {
    throw new ConfigError(`PUBLIC_ORIGIN must be an origin without path, query or credentials, e.g. ${url.protocol}//${url.host}`)
  }
  const loopback = isLoopbackHost(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError(`PUBLIC_ORIGIN must use https (http only for a loopback address), got ${url.origin}`)
  }
  return { origin: url.origin, loopback }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
}

function parsePort(raw: string | undefined): number {
  const value = raw?.trim() || '3000'
  const port = Number(value)
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got ${value}`)
  }
  return port
}

// Fastify would also take `true` or a hop count, which let any client that
// reaches the port claim an arbitrary address and protocol. Only explicit
// addresses and CIDRs are accepted; unset means loopback only.
function parseTrustProxy(raw: string | undefined): string[] {
  const entries = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (entries.length === 0) return loopbackOnly
  const bad = entries.filter((entry) => !isAddressOrCidr(entry))
  if (bad.length > 0) {
    throw new ConfigError(`TRUST_PROXY must list IP addresses or CIDRs separated by commas, got ${bad.join(', ')}`)
  }
  return entries
}

function isAddressOrCidr(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/')
  const family = isIP(address)
  if (family === 0 || rest.length > 0) return false
  if (prefix === undefined) return true
  return /^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)
}

// debug and trace exist for local development only: libraries log more at
// those levels than this application controls. They need both a loopback
// origin and a loopback listening address, so a server anyone else can
// reach, such as a container listening on 0.0.0.0, cannot switch them on,
// whatever its origin says.
function parseLogLevel(raw: string | undefined, local: boolean): LogLevel {
  const value = raw?.trim() || 'info'
  if (value === 'info' || value === 'warn' || value === 'error') return value
  if ((value === 'debug' || value === 'trace') && local) return value
  if (value === 'debug' || value === 'trace') {
    throw new ConfigError(`LOG_LEVEL=${value} is allowed only with a loopback PUBLIC_ORIGIN and HOST`)
  }
  throw new ConfigError(`LOG_LEVEL must be info, warn or error, got ${value}`)
}
