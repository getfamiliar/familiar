import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "@getfamiliar/shared";
import { Cron } from "croner";

/** Top of every hour. Fine-grained enough for retention windows of a day and up. */
const DIRECTORY_GC_SCHEDULE = "0 * * * *";

export interface DirectoryGcConfig {
    /** Absolute host path of the directory to sweep (e.g. `tmp/scratch/`). */
    readonly dir: string;
    /** Entries whose mtime is older than this many milliseconds are removed. */
    readonly retentionMs: number;
    /**
     * Short label of the swept directory (e.g. `"scratch"`, `"llm-debug"`).
     * Prefixes every log line so a human tailing the log can tell sweeps apart.
     */
    readonly name: string;
    /** Logger; one line per removed entry at `info`. */
    readonly log: Logger;
}

/**
 * Hourly Croner job that sweeps a flat directory of mtime-aged entries,
 * removing every immediate child (subdirectory, file or symlink) whose
 * mtime is older than the configured retention window.
 *
 * Used for `tmp/scratch/` (per-event subdirectories, 24 h — kept long
 * enough for post-mortem inspection of how a handler reasoned, so
 * cleanup is not tied to event terminal state) and `tmp/llm-debug/`
 * (model HTTP captures, `inference.llmDebugRetentionDays`). A missing
 * directory is a silent no-op, so a sweep over a not-yet-created
 * capture dir costs nothing.
 */
export class DirectoryGc {
    private readonly dir: string;
    private readonly retentionMs: number;
    private readonly name: string;
    private readonly log: Logger;
    private job: Cron | undefined;

    constructor(config: DirectoryGcConfig) {
        this.dir = config.dir;
        this.retentionMs = config.retentionMs;
        this.name = config.name;
        this.log = config.log;
    }

    /** Schedule the hourly sweep. Safe to call once at daemon startup. */
    start(): void {
        if (this.job) {
            return;
        }
        this.job = new Cron(DIRECTORY_GC_SCHEDULE, () => {
            void this.sweep();
        });
        this.log.info(
            { dir: this.dir, retentionMs: this.retentionMs, schedule: DIRECTORY_GC_SCHEDULE },
            `${this.name} GC scheduled for ${this.dir}`,
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
     * One pass through the directory: lstat every immediate child (dirs,
     * files and symlinks alike — a symlink is removed, never followed),
     * remove those whose mtime is older than the retention threshold. Exposed
     * for direct testing — a test can backdate an entry's mtime and call
     * `sweep()` instead of waiting for the next hour boundary.
     */
    async sweep(): Promise<void> {
        let entries: string[];
        try {
            entries = await fs.readdir(this.dir);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
                return;
            }
            this.log.error(
                { err: err instanceof Error ? err.message : String(err) },
                `${this.name} GC readdir failed for ${this.dir}`,
            );
            return;
        }

        const cutoff = Date.now() - this.retentionMs;
        for (const entryName of entries) {
            const full = path.join(this.dir, entryName);
            let stat: Awaited<ReturnType<typeof fs.lstat>>;
            try {
                stat = await fs.lstat(full);
            } catch (err) {
                // Vanished between readdir and lstat — nothing left to sweep.
                if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                    continue;
                }
                this.log.error(
                    { path: full, err: err instanceof Error ? err.message : String(err) },
                    `${this.name} GC lstat failed for ${full}`,
                );
                continue;
            }
            if (stat.mtimeMs > cutoff) {
                continue;
            }
            const kind = stat.isDirectory() ? "dir" : "file";
            try {
                await fs.rm(full, { recursive: true, force: true });
                this.log.info(
                    { path: full, mtime: stat.mtime },
                    `${this.name} GC removed ${kind} ${full}`,
                );
            } catch (err) {
                this.log.error(
                    { path: full, err: err instanceof Error ? err.message : String(err) },
                    `${this.name} GC rm failed for ${full}`,
                );
            }
        }
    }
}
