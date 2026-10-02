import pg from 'pg'

export interface Database {
  query: <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) => Promise<pg.QueryResult<R>>
  /** Runs fn in a transaction: commit on success, rollback on throw, client always released. */
  tx: <T>(fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>
  close: () => Promise<void>
}

export function createDatabase(connectionString: string, onIdleError: (err: Error) => void): Database {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    // Fail a boot, a health check or a request in bounded time instead of
    // hanging on an unreachable or stuck server.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: 'school-election',
  })
  // Without a listener, an idle client that loses its connection would
  // crash the process with an unhandled 'error' event.
  pool.on('error', onIdleError)

  return {
    query: (text, values) => pool.query(text, values),
    async tx(fn) {
      const client = await pool.connect()
      let broken = false
      try {
        await client.query('begin')
        const result = await fn(client)
        await client.query('commit')
        return result
      } catch (err) {
        try {
          await client.query('rollback')
        } catch {
          // A connection that cannot even roll back is not reused.
          broken = true
        }
        throw err
      } finally {
        client.release(broken)
      }
    },
    close: () => pool.end(),
  }
}

/** user@host:port/database, for log lines: never the password. */
export function describeDatabase(connectionString: string): string {
  const url = new URL(connectionString)
  return `${decodeURIComponent(url.username)}@${url.host}${url.pathname}`
}
