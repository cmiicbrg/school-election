// The lane the voter page's requests run through, and the session each of
// them belongs to, for the tab rather than for one mounting of the page:
// a page left while a request was on its way and mounted again shares
// them with that request, so the next card is redeemed only after that
// answer is in, and the answer, belonging to a session that is over,
// changes nothing. Free of the DOM, so node:test checks it.

let lane: Promise<void> = Promise.resolve()
let session = 0
let queued: string | undefined

/** Runs `fn` after everything before it in the lane; `fn` answers for its own errors. */
export function inLane(fn: () => Promise<void>): void {
  lane = lane.then(fn, fn)
}

/** The session the next request belongs to. */
export function currentSession(): number {
  return session
}

/** Starts a new session: whatever is still on its way belongs to the one before. */
export function nextSession(): number {
  session += 1
  return session
}

/** Whether a request that started in session `mine` still speaks for the page. */
export function stale(mine: number): boolean {
  return mine !== session
}

/** A key to redeem once the lane is free; a later one replaces one still waiting. */
export function queueKey(key: string): void {
  queued = key
}

/** The key waiting, if any, and no longer waiting afterwards. */
export function takeQueuedKey(): string | undefined {
  const key = queued
  queued = undefined
  return key
}

export function keyQueued(): boolean {
  return queued !== undefined
}
