/**
 * Small in-process cache for expensive reads: entries expire after `ttlMs`, concurrent calls for
 * the same key share one computation, and failures are never cached. Per process, so with several
 * API instances each keeps its own copy (a shared store such as Redis would be the next step).
 */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; expires: number }>();
  private inflight = new Map<string, Promise<T>>();

  constructor(
    private ttlMs: number,
    private maxEntries = 500,
    private now: () => number = Date.now,
  ) {}

  async get(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) return hit.value;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = compute()
      .then((value) => {
        this.entries.delete(key); // re-insert so Map order tracks recency
        this.entries.set(key, { value, expires: this.now() + this.ttlMs });
        this.evict();
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    const t = this.now();
    for (const [k, e] of this.entries)
      if (e.expires <= t) this.entries.delete(k);
    while (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value as string);
  }
}
