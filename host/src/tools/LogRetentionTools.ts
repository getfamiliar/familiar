import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { LogStream } from "effective-assistant-shared";
import type { DestinationStream } from "pino";

/**
 * Daily-rotated file sink in `dir`. Filenames follow
 * `ea.YYYYMMDD.<n>.log`; pino-roll always appends a `.<number>`
 * segment and we let it default to `.1` (size-based rotation isn't
 * configured, so only the date segment changes day to day).
 *
 * `retentionDays` keeps that many *additional* files beyond the
 * active one — see pino-roll's `limit.count`. Two pruning paths:
 *
 *   - {@link pruneStaleLogs} runs once at startup so retention takes
 *     effect immediately on a fresh daemon.
 *   - pino-roll's own pruner (`removeOtherLogFiles: true`) runs on
 *     every rotation (midnight) and scans the directory by birthtime
 *     so it survives daemon restarts.
 *
 * Host-only: pino-roll is only depended on here, and the daemon is
 * the only process that wants daily-rotated files. The container
 * writes raw JSON to stdout and the host streams those into the
 * same file.
 *
 * @throws If `pino-roll` cannot create the directory.
 */
export async function rollingFileStream(dir: string, retentionDays: number): Promise<LogStream> {
    await pruneStaleLogs(dir, retentionDays);
    // pino-roll has no bundled type declarations — cast through unknown
    // since the export shape is documented in its README.
    const mod = (await import("pino-roll" as string)) as {
        default: (opts: Record<string, unknown>) => Promise<DestinationStream>;
    };
    const pinoRoll = mod.default;
    const stream = await pinoRoll({
        file: `${dir}/ea`,
        frequency: "daily",
        dateFormat: "yyyyMMdd",
        extension: ".log",
        mkdir: true,
        // Default `removeOtherLogFiles: false` only tracks files this
        // process opened — across daemon restarts the in-memory list
        // resets and old files are never pruned. `true` makes pino-roll
        // scan the directory at every roll() and prune by birthtime.
        limit: { count: retentionDays, removeOtherLogFiles: true },
    });
    return { stream };
}

/**
 * Delete log files in `dir` whose date stamp is older than today minus
 * `retentionDays`. Filename pattern is `ea.YYYYMMDD.<n>.log`; the date
 * is parsed straight from the name (more reliable than `birthtime`,
 * which can be lost across copies and bind-mount remounts).
 *
 * Runs at startup so retention takes effect immediately — pino-roll's
 * own pruner only fires on rotation (midnight), which a daemon that
 * restarts during the day would never reach.
 *
 * Best-effort: a non-existent directory is treated as empty; failures
 * to unlink are swallowed so a permission glitch on one file doesn't
 * block daemon startup.
 */
async function pruneStaleLogs(dir: string, retentionDays: number): Promise<void> {
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        return;
    }
    const cutoff = startOfDayUtc(new Date());
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
    const cutoffMs = cutoff.getTime();
    const pattern = /^ea\.(\d{4})(\d{2})(\d{2})\.\d+\.log$/;
    await Promise.allSettled(
        entries.map(async (name) => {
            const match = pattern.exec(name);
            if (!match) {
                return;
            }
            const [, y, m, d] = match;
            const fileDate = Date.UTC(Number(y), Number(m) - 1, Number(d));
            if (fileDate >= cutoffMs) {
                return;
            }
            try {
                await unlink(join(dir, name));
            } catch {
                // ignore — best effort
            }
        }),
    );
}

/** UTC midnight of the given date. Used so retention boundaries are stable across timezones. */
function startOfDayUtc(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
