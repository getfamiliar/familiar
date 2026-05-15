import { promises as fs } from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import type { Logger } from "effective-assistant-shared";

/**
 * 24 hours, in milliseconds. Subdirectories of `agentTmpDir` whose
 * directory mtime is older than this are removed by each sweep. Picked
 * to give the operator a comfortable window to inspect post-mortem
 * scratch contents (e.g. an email attachment that produced a confusing
 * handler outcome) without manual cleanup later.
 */
const SCRATCH_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Top of every hour. Fine-grained enough for a 24 h retention window. */
const SCRATCH_GC_SCHEDULE = "0 * * * *";

export interface ScratchGcConfig {
    /** Absolute host path of `data/agent-tmp/`. */
    readonly agentTmpDir: string;
    /** Logger; one line per removed dir at `info`. */
    readonly log: Logger;
}

/**
 * Hourly Croner job that sweeps `agentTmpDir`, removing per-event
 * scratch directories whose mtime is older than 24 hours.
 *
 * The retention window is intentionally generous — scratch files (mail
 * attachments, intermediate artifacts) are useful for post-mortem
 * inspection of how a handler reasoned, so we don't tie cleanup to
 * event terminal state. A still-running event whose subdir is older
 * than 24 h would in practice keep its mtime fresh via handler writes;
 * if it doesn't, the event has been stuck long enough that the user
 * almost certainly wants the dir gone.
 */
export class ScratchGc {
    private readonly agentTmpDir: string;
    private readonly log: Logger;
    private job: Cron | undefined;

    constructor(config: ScratchGcConfig) {
        this.agentTmpDir = config.agentTmpDir;
        this.log = config.log;
    }

    /** Schedule the hourly sweep. Safe to call once at daemon startup. */
    start(): void {
        if (this.job) {
            return;
        }
        this.job = new Cron(SCRATCH_GC_SCHEDULE, () => {
            void this.sweep();
        });
        this.log.info(
            { agentTmpDir: this.agentTmpDir, schedule: SCRATCH_GC_SCHEDULE },
            "scratch GC scheduled",
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
     * One pass through `agentTmpDir`: stat every immediate child, remove
     * those whose mtime is older than the retention threshold. Exposed
     * for direct testing — a test can backdate a dir's mtime and call
     * `sweep()` instead of waiting for the next hour boundary.
     */
    async sweep(): Promise<void> {
        let entries: string[];
        try {
            entries = await fs.readdir(this.agentTmpDir);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
                return;
            }
            this.log.error(
                { err: err instanceof Error ? err.message : String(err) },
                "scratch GC readdir failed",
            );
            return;
        }

        const cutoff = Date.now() - SCRATCH_RETENTION_MS;
        for (const name of entries) {
            const full = path.join(this.agentTmpDir, name);
            let stat: Awaited<ReturnType<typeof fs.stat>>;
            try {
                stat = await fs.stat(full);
            } catch {
                continue;
            }
            if (!stat.isDirectory()) {
                continue;
            }
            if (stat.mtimeMs > cutoff) {
                continue;
            }
            try {
                await fs.rm(full, { recursive: true, force: true });
                this.log.info({ dir: full, mtime: stat.mtime }, "scratch GC removed dir");
            } catch (err) {
                this.log.error(
                    { dir: full, err: err instanceof Error ? err.message : String(err) },
                    "scratch GC rm failed",
                );
            }
        }
    }
}
