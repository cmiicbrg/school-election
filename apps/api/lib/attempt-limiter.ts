// Slows down whoever tries keys that do not exist. Entropy is the defence
// (95 random bits a key), this is the nuisance: only failures count, per
// source address, in memory, never logged and never persisted. A failing
// answer waits for a backoff that doubles from a quarter second and is
// capped, and more than a handful of failing answers in flight from one
// source are refused outright. A redemption with a key that exists is
// never delayed or refused here, so a hall behind one address votes at
// full speed, however many typos it makes.

export interface LimiterOptions {
  /** The delay of the second failure from a source; the first waits half of it. */
  baseDelayMs?: number
  maxDelayMs?: number
  /** Failing answers in flight from one source beyond which the next is refused. */
  maxInFlight?: number
  /** A source that failed nothing for this long starts over. */
  quietMs?: number
  now?: () => number
}

interface Source {
  failures: number
  lastAt: number
  inFlight: number
}

export type Verdict = { delayMs: number } | 'refused'

export class AttemptLimiter {
  private readonly sources = new Map<string, Source>()
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly maxInFlight: number
  private readonly quietMs: number
  private readonly now: () => number
  /** Every failure counted since the start, for the health endpoint's eyes; never throttles. */
  failures = 0

  constructor({ baseDelayMs = 500, maxDelayMs = 4_000, maxInFlight = 8, quietMs = 10 * 60_000, now = Date.now }: LimiterOptions = {}) {
    this.baseDelayMs = baseDelayMs
    this.maxDelayMs = maxDelayMs
    this.maxInFlight = maxInFlight
    this.quietMs = quietMs
    this.now = now
  }

  /** A failing answer to `source` is about to go out: how long it waits, or that it is refused. Pair with `end`. */
  begin(source: string): Verdict {
    const now = this.now()
    this.sweep(now)
    const entry = this.sources.get(source) ?? { failures: 0, lastAt: now, inFlight: 0 }
    if (now - entry.lastAt > this.quietMs) entry.failures = 0
    if (entry.inFlight >= this.maxInFlight) return 'refused'
    const delayMs = Math.min(this.baseDelayMs * 2 ** entry.failures / 2, this.maxDelayMs)
    entry.failures += 1
    entry.lastAt = now
    entry.inFlight += 1
    this.sources.set(source, entry)
    this.failures += 1
    return { delayMs }
  }

  /** The failing answer went out. */
  end(source: string): void {
    const entry = this.sources.get(source)
    if (entry && entry.inFlight > 0) entry.inFlight -= 1
  }

  // Sources that have been quiet are forgotten, so the map stays the size
  // of the current nuisance, not of the day's.
  private sweep(now: number): void {
    if (this.sources.size < 1_000) return
    for (const [source, entry] of this.sources) {
      if (entry.inFlight === 0 && now - entry.lastAt > this.quietMs) this.sources.delete(source)
    }
  }
}
