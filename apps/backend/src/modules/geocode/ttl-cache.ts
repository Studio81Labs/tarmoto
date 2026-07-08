/**
 * Minimal bounded, TTL'd in-memory cache — no external dependency (the backend
 * has no cache-manager). Insertion order doubles as recency: `get` re-inserts a
 * live entry (moving it to the newest slot) and `set` evicts the oldest once
 * over capacity, giving LRU-ish eviction.
 *
 * Sized for the geocode proxy (#909): collapses repeated typeahead prefixes and
 * common places into hits so public Nominatim isn't re-queried for the same
 * input. Process-local — a multi-instance deploy caches per instance, which is
 * fine for load reduction (no correctness dependency on a shared cache).
 */
export class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expiresAt: number }>();

  /**
   * @param maxEntries hard cap on retained entries (oldest evicted first)
   * @param ttlMs how long an entry stays fresh after it is written
   * @param now clock injection point for deterministic tests
   */
  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh recency: re-insert so this becomes the most-recently used.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Current retained entry count (used by tests and health/inspection). */
  get size(): number {
    return this.store.size;
  }
}
