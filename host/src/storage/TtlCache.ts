/**
 * Minimal in-memory cache with a fixed time-to-live per entry. Expired
 * entries are dropped lazily on read and on every write once the cache
 * exceeds `maxEntries`.
 */
export class TtlCache<V> {
    private readonly entries = new Map<string, { value: V; expiresAt: number }>();

    /**
     * @param ttlMs - Lifetime of an entry in milliseconds.
     * @param maxEntries - Soft cap that triggers a sweep of expired entries.
     * @param now - Clock, injectable for tests.
     */
    constructor(
        private readonly ttlMs: number,
        private readonly maxEntries = 5000,
        private readonly now: () => number = Date.now,
    ) {}

    /** @returns The live value for `key`, or `undefined`. */
    get(key: string): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value;
    }

    /** Store `value` under `key`. */
    set(key: string, value: V): void {
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
        if (this.entries.size > this.maxEntries) {
            this.sweep();
        }
    }

    /** Drop every entry whose key starts with `prefix`. */
    deletePrefix(prefix: string): void {
        for (const key of this.entries.keys()) {
            if (key.startsWith(prefix)) {
                this.entries.delete(key);
            }
        }
    }

    /** Remove expired entries. */
    private sweep(): void {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) {
                this.entries.delete(key);
            }
        }
    }
}
