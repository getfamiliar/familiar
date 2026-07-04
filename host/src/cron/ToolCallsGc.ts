import type { Logger, ToolCallBus } from "@getfamiliar/shared";
import { Cron } from "croner";

/**
 * How many tool-call rows to keep per handler file. The heuristic
 * preloader only ever scans a small recent window (a few dozen runs),
 * so anything beyond a couple hundred rows per handler is dead weight.
 */
const KEEP_PER_HANDLER = 200;

/** Top of every hour — matches the other host-side GC cadence. */
const TOOL_CALLS_GC_SCHEDULE = "0 * * * *";

export interface ToolCallsGcConfig {
    /** Bus client for the `tool_calls` table. */
    readonly toolCallBus: ToolCallBus;
    /** Logger; one line per non-empty sweep at `info`. */
    readonly log: Logger;
    /** Rows kept per handler_path; defaults to {@link KEEP_PER_HANDLER}. */
    readonly keepPerHandler?: number;
}

/**
 * Hourly Croner job that trims the `tool_calls` table, keeping only the
 * newest {@link KEEP_PER_HANDLER} rows per handler file and deleting the
 * rest. Append-only usage records accumulate on every tool call, but
 * the heuristic preloader reads only a small recent window, so the tail
 * is pure storage waste — this GC bounds it.
 */
export class ToolCallsGc {
    private readonly toolCallBus: ToolCallBus;
    private readonly log: Logger;
    private readonly keepPerHandler: number;
    private job: Cron | undefined;

    constructor(config: ToolCallsGcConfig) {
        this.toolCallBus = config.toolCallBus;
        this.log = config.log;
        this.keepPerHandler = config.keepPerHandler ?? KEEP_PER_HANDLER;
    }

    /** Schedule the hourly sweep. Safe to call once at daemon startup. */
    start(): void {
        if (this.job) {
            return;
        }
        this.job = new Cron(TOOL_CALLS_GC_SCHEDULE, () => {
            void this.sweep();
        });
        this.log.info(
            { schedule: TOOL_CALLS_GC_SCHEDULE, keepPerHandler: this.keepPerHandler },
            `tool_calls GC scheduled (keeping ${this.keepPerHandler} rows per handler)`,
        );
    }

    /** Cancel the cron and forget the handle. */
    stop(): void {
        if (!this.job) {
            return;
        }
        this.job.stop();
        this.job = undefined;
    }

    /**
     * One trim pass. Exposed for direct testing — a test can seed rows
     * and call `sweep()` instead of waiting for the next hour boundary.
     */
    async sweep(): Promise<void> {
        try {
            const removed = await this.toolCallBus.pruneKeepingPerHandler(this.keepPerHandler);
            if (removed > 0) {
                this.log.info(
                    { removed, keepPerHandler: this.keepPerHandler },
                    `tool_calls GC removed ${removed} old row(s), keeping ${this.keepPerHandler} per handler`,
                );
            }
        } catch (err) {
            this.log.error(
                { err: err instanceof Error ? err.message : String(err) },
                "tool_calls GC sweep failed",
            );
        }
    }
}
