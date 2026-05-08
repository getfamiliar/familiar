import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { LogStream } from "effective-assistant-shared";
import type { DestinationStream } from "pino";

/**
 * Daily-rotated file sink in `dir`, prefixed by `prefix`. Filenames
 * follow `<prefix>.YYYYMMDD.<n>.log`; pino-roll always appends a
 * `.<number>` segment and we let it default to `.1` (size-based
 * rotation isn't configured, so only the date segment changes day to
 * day).
 *
 * `retentionDays` keeps that many *additional* files beyond the
 * active one — see pino-roll's `limit.count`. Two pruning paths:
 *
 *   - {@link pruneStaleLogs} runs once at sink creation so retention
 *     takes effect immediately on a fresh daemon.
 *   - pino-roll's own pruner (`removeOtherLogFiles: true`) runs on
 *     every rotation (midnight) and scans the directory by birthtime
 *     so it survives daemon restarts.
 *
 * The prefix is per-caller so multiple sinks can coexist in the same
 * directory without cross-pruning each other (e.g. the per-MCP files
 * in `data/logs/mcp/` use the MCP id as the prefix). The startup
 * pruner's regex is anchored on `<prefix>.` so it touches only its
 * own files.
 *
 * Host-only: pino-roll is only depended on here, and the daemon is
 * the only process that wants daily-rotated files. The container
 * writes raw JSON to stdout and the host streams those into the
 * same file.
 *
 * @throws If `pino-roll` cannot create the directory.
 */
export async function rollingFileStream(
    dir: string,
    prefix: string,
    retentionDays: number,
): Promise<LogStream> {
    const stream = await openRollingStream(dir, prefix, retentionDays);
    return { stream };
}

/**
 * Time the {@link McpFileSink.close} race waits for the underlying
 * stream's `'finish'` / `'close'` event before giving up. Pino-roll
 * sits on top of SonicBoom whose `end()` does not reliably invoke a
 * callback; if neither event fires we move on so shutdown can never
 * wedge here. Worst case: the kernel flushes any in-flight `write()`
 * calls when the fd is closed at process exit; we may miss the
 * trailing newline of the last record. Acceptable trade.
 */
const SINK_CLOSE_TIMEOUT_MS = 1000;

/**
 * Plain-text appender backed by a daily-rotated file. Used by the
 * MCP per-child log files: each line gets a fixed-width prefix
 * (`HH:MM:SS.mmm  out  ` / `HH:MM:SS.mmm  err  `) and is written
 * directly to the rotated stream. No pino, no JSON, no record
 * metadata — chatty MCPs that route `console.log` through stderr
 * stay readable.
 *
 * The sink is opened lazily (the first {@link write} call creates
 * the file via pino-roll); MCPs that never spawn don't leave empty
 * log files behind.
 */
export interface McpFileSink {
    /** Write one line tagged as stdout (`out`) or stderr (`err`). */
    write(source: McpSource, line: string): void;
    /** Flush + close the underlying stream. Idempotent. */
    close(): Promise<void>;
}

/** Source tag emitted into the per-MCP log line prefix. */
export type McpSource = "out" | "err";

/**
 * Open a per-MCP rotated file sink at `<dir>/<mcpId>.*`. Same
 * rotation + retention behavior as the main daemon log.
 */
export async function createMcpFileSink(
    dir: string,
    mcpId: string,
    retentionDays: number,
): Promise<McpFileSink> {
    const stream = await openRollingStream(dir, mcpId, retentionDays);
    let closed = false;
    return {
        write(source, line) {
            if (closed) {
                return;
            }
            stream.write(`${formatMcpLine(source, line)}\n`);
        },
        async close() {
            if (closed) {
                return;
            }
            closed = true;
            // SonicBoom (pino-roll's underlying stream) doesn't
            // reliably call a callback passed to `end()`. Wait for
            // the `'finish'` / `'close'` event instead, and race
            // both against {@link SINK_CLOSE_TIMEOUT_MS} so a
            // stuck flush can never wedge the daemon's shutdown.
            const writable = stream as unknown as {
                end?: () => void;
                once?: (event: "close" | "finish", cb: () => void) => void;
            };
            const end = writable.end;
            if (typeof end !== "function") {
                return;
            }
            await new Promise<void>((resolve) => {
                let done = false;
                const finish = (): void => {
                    if (done) {
                        return;
                    }
                    done = true;
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(finish, SINK_CLOSE_TIMEOUT_MS);
                writable.once?.("close", finish);
                writable.once?.("finish", finish);
                try {
                    end.call(stream);
                } catch {
                    finish();
                }
            });
        },
    };
}

/**
 * Format a single line for the per-MCP log file. Output shape:
 *
 *     HH:MM:SS.mmm  out  the actual line
 *     HH:MM:SS.mmm  err  the actual line
 *
 * Prefix width is **19 chars** regardless of content (12-char
 * timestamp, 2-space, 3-char source, 2-space) so messages line up
 * column-perfect when scanning the file. Embedded `\n` in the
 * input is replaced with a literal space to keep the one-line
 * invariant; trailing whitespace is left untouched.
 *
 * Exported for unit testing — call sites use {@link McpFileSink.write}
 * which formats internally.
 */
export function formatMcpLine(source: McpSource, line: string, now: Date = new Date()): string {
    const ts = formatTimeOfDay(now);
    const flat = line.replace(/[\r\n]+/g, " ");
    return `${ts}  ${source}  ${flat}`;
}

/**
 * Internal: open the pino-roll stream and run a one-shot startup
 * prune. Shared by the LogStream wrapper and the MCP sink builder.
 */
async function openRollingStream(
    dir: string,
    prefix: string,
    retentionDays: number,
): Promise<DestinationStream> {
    await pruneStaleLogs(dir, prefix, retentionDays);
    // pino-roll has no bundled type declarations — cast through unknown
    // since the export shape is documented in its README.
    const mod = (await import("pino-roll" as string)) as {
        default: (opts: Record<string, unknown>) => Promise<DestinationStream>;
    };
    const pinoRoll = mod.default;
    return pinoRoll({
        file: `${dir}/${prefix}`,
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
}

/**
 * Delete log files in `dir` whose `<prefix>.YYYYMMDD.<n>.log` date
 * is older than today minus `retentionDays`. The date is parsed
 * straight from the name (more reliable than `birthtime`, which
 * can be lost across copies and bind-mount remounts).
 *
 * Per-prefix on purpose: when the same directory holds multiple
 * sinks (e.g. one log file per MCP id), each call only touches
 * its own prefix's files.
 *
 * Best-effort: a non-existent directory is treated as empty;
 * failures to unlink are swallowed so a permission glitch on one
 * file doesn't block daemon startup.
 */
async function pruneStaleLogs(dir: string, prefix: string, retentionDays: number): Promise<void> {
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        return;
    }
    const cutoff = startOfDayUtc(new Date());
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
    const cutoffMs = cutoff.getTime();
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}\\.(\\d{4})(\\d{2})(\\d{2})\\.\\d+\\.log$`);
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

/** `HH:MM:SS.mmm` (UTC, fixed 12-char width). */
function formatTimeOfDay(d: Date): string {
    return (
        `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}` +
        `.${pad3(d.getUTCMilliseconds())}`
    );
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function pad3(n: number): string {
    if (n < 10) {
        return `00${n}`;
    }
    if (n < 100) {
        return `0${n}`;
    }
    return String(n);
}
