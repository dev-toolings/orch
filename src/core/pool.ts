// Bounded worker pool: the same helper the benches and Hindsight seed share.
export async function pool<T>(xs: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    while (i < xs.length) await f(xs[i++]);
  }));
}
