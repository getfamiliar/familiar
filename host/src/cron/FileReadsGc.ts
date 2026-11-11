import type { FileReadBus, Logger } from "@getfamiliar/shared";
import { Cron } from "croner";

/** Default of `core.fileReadRetentionDays`. */
export const DEFAULT_FILE_READ_RETENTION_DAYS = 14;

/** Top of every hour — matches the other host-side GC cadence. */
const FILE_READS_GC_SCHEDULE = "0 * * * *";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface FileReadsGcConfig {
    /** Bus client for the `file_reads` table. */
    readonly fileReadBus: FileReadBus;
    /** Logger; one line per non-empty sweep at `info`. */
    readonly log: Logger;
    /** Retention in days, read on every sweep (`core.fileReadRetentionDays`), so a reload applies. */
    readonly retentionDays: () => number;
}

/**
 * Hourly Croner job that deletes `file_reads` rows older than
 * `core.fileReadRetentionDays`. The rows are written on every `fs_read` of a
 * workspace file; consumers (e.g. the memory plugin's "hot" files) only look
 * at that window, so older rows are dead weight.
 */
export class FileReadsGc {
    private readonly fileReadBus: FileReadBus;
    private readonly log: Logger;
    private readonly retentionDays: () => number;
    private job: Cron | undefined;

    /**
     * @param config - Bus, logger, retention.
     */
    constructor(config: FileReadsGcConfig) {
        this.fileReadBus = config.fileReadBus;
        this.log = config.log;
        this.retentionDays = config.retentionDays;
    }

    /** Schedule the hourly sweep. Safe to call once at daemon startup. */
    start(): void {
        if (this.job) {
            return;
        }
        this.job = new Cron(FILE_READS_GC_SCHEDULE, () => {
            void this.sweep();
        });
        this.log.info(
            { schedule: FILE_READS_GC_SCHEDULE },
            `file_reads GC scheduled (keeping ${this.retentionDays()} days)`,
        );
    }

    /** Cancel the cron and forget the handle. */
    stop(): void {
        this.job?.stop();
        this.job = undefined;
    }

    /**
     * One pass. Exposed for direct testing.
     *
     * @returns Resolves when done; never rejects (failures are logged).
     */
    async sweep(): Promise<void> {
        const days = this.retentionDays();
        try {
            const removed = await this.fileReadBus.pruneBefore(
                new Date(Date.now() - days * ONE_DAY_MS),
            );
            if (removed > 0) {
                this.log.info(
                    { removed, retentionDays: days },
                    `file_reads GC removed ${removed} read(s) older than ${days} days`,
                );
            }
        } catch (err) {
            this.log.error(
                { err: err instanceof Error ? err.message : String(err) },
                `file_reads GC sweep failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}
