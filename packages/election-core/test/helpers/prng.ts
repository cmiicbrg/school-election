// Deterministic randomness for property tests. A fixed seed makes every run
// draw the same cases, so a failure reproduces exactly; no dependency needed.

/** mulberry32: a small, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randomInt(random: () => number, maxExclusive: number): number {
  return Math.floor(random() * maxExclusive)
}

/** Fisher–Yates on a copy. */
export function shuffle<T>(random: () => number, items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(random, i + 1)
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

/** Every ordering of `items`; n! results, so keep n small. */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  )
}
