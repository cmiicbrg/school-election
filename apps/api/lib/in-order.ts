/**
 * Runs `step` for each item, one after another: each starts only when the
 * previous one has finished. For work on one transaction's connection that
 * has to happen in order, such as audit events, each of which chains to the
 * one before it.
 */
export async function inOrder<T>(items: Iterable<T>, step: (item: T) => Promise<unknown>): Promise<void> {
  let previous: Promise<unknown> = Promise.resolve()
  for (const item of items) previous = previous.then(() => step(item))
  await previous
}
