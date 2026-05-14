import type { MailProvider, MailProviderDeps } from "./providers/MailProvider.js";

/** One active provider tracked by the loop. */
interface ActiveProvider {
    readonly provider: MailProvider;
    readonly deps: MailProviderDeps;
    failures: number;
    timer: NodeJS.Timeout | null;
}

/**
 * Multi-provider polling supervisor. Each active provider gets its
 * own setTimeout that fires after `pollingIntervalMinutes` on
 * success or an exponentially-backed-off delay after a failure.
 *
 * One supervisor instance per plugin lifetime. Stop tears down all
 * pending timers; an in-flight `pollOnce` is allowed to finish
 * (its emits are idempotency-key-gated, so a double-emit on a race
 * between completion and stop is a no-op at the bus level).
 */
export class MailPollLoop {
    private readonly intervalMs: number;
    private readonly backoffBaseMs: number;
    private readonly backoffCapMs: number;
    private active: ActiveProvider[] = [];
    private stopped = false;

    constructor(intervalMinutes: number, backoffMinutes: number) {
        this.intervalMs = intervalMinutes * 60_000;
        this.backoffBaseMs = backoffMinutes * 60_000;
        // Cap backoff at 4× the interval so a stuck provider still
        // retries roughly every hour for the default 15-min cadence.
        this.backoffCapMs = this.intervalMs * 4;
    }

    /** Register a provider and schedule its first poll immediately. */
    register(provider: MailProvider, deps: MailProviderDeps): void {
        const entry: ActiveProvider = { provider, deps, failures: 0, timer: null };
        this.active.push(entry);
        // Kick off the first poll asynchronously so `register` returns
        // without doing I/O — the plugin's `start(ctx)` resolves
        // promptly and host startup isn't blocked. `.unref()` so an
        // idle plugin doesn't keep the event loop alive on its own;
        // the daemon exits via SIGTERM-driven `process.exit`, not via
        // running out of work.
        entry.timer = setTimeout(() => this.tick(entry), 0);
        entry.timer.unref();
    }

    /** Cancel every pending timer. Idempotent. */
    stop(): void {
        this.stopped = true;
        for (const entry of this.active) {
            if (entry.timer !== null) {
                clearTimeout(entry.timer);
                entry.timer = null;
            }
        }
        this.active = [];
    }

    private async tick(entry: ActiveProvider): Promise<void> {
        if (this.stopped) {
            return;
        }
        try {
            await entry.provider.pollOnce(entry.deps);
            entry.failures = 0;
        } catch (err) {
            entry.failures += 1;
            const message = err instanceof Error ? err.message : String(err);
            const delay = this.backoffDelay(entry.failures);
            entry.deps.log(
                `poll error (#${entry.failures}): ${message}; next try in ${Math.round(delay / 60_000)}m`,
            );
            if (this.stopped) {
                return;
            }
            entry.timer = setTimeout(() => this.tick(entry), delay);
            entry.timer.unref();
            return;
        }
        if (this.stopped) {
            return;
        }
        entry.timer = setTimeout(() => this.tick(entry), this.intervalMs);
        entry.timer.unref();
    }

    private backoffDelay(failures: number): number {
        const exp = Math.min(2 ** (failures - 1), 1024);
        return Math.min(this.backoffBaseMs * exp, this.backoffCapMs);
    }
}
