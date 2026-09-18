/**
 * Map over `items` with at most `limit` promises in flight.
 *
 * The analysis routes fan out over dozens to hundreds of ESPN/MLB requests. A
 * blanket `Promise.all` fires them all at once, and ESPN's edge throttles
 * bursts — the per-item `catch` blocks would then swallow the failures and the
 * data would silently come back missing rather than erroring.
 *
 * Results keep the input order, so callers can index into them as before.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (let i = next++; i < items.length; i = next++) {
        results[i] = await fn(items[i], i);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
