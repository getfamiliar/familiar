import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Logger } from "effective-assistant-shared";

/**
 * Result of probing the pidfile on disk. Returned by
 * {@link inspectPidFile} so callers can branch on a discrete shape
 * rather than juggling tri-state booleans.
 *
 * - `vacant`     — file does not exist; safe to write.
 * - `alive`      — file exists, content parses, process responds to
 *                  signal 0 (it's running).
 * - `stale`      — file exists, content parses, but the process is
 *                  gone (crash, kill -9, OS reboot).
 * - `malformed`  — file exists but the content isn't a positive
 *                  integer; treat as stale for cleanup purposes.
 */
export type PidFileStatus =
    | { readonly kind: "vacant" }
    | { readonly kind: "alive"; readonly pid: number }
    | { readonly kind: "stale"; readonly pid: number }
    | { readonly kind: "malformed" };

/**
 * Read and classify the pidfile at `path`. Pure-ish: only filesystem
 * + `process.kill(pid, 0)`, no logging or side effects. Designed to
 * be unit-testable against a tmpdir fixture.
 */
export function inspectPidFile(path: string): PidFileStatus {
    if (!existsSync(path)) {
        return { kind: "vacant" };
    }
    const raw = readFileSync(path, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
        return { kind: "malformed" };
    }
    return isProcessAlive(pid) ? { kind: "alive", pid } : { kind: "stale", pid };
}

/**
 * Probe whether a pid corresponds to a running process. `process.kill(pid, 0)`
 * sends no signal — it just checks delivery. ESRCH means "no such
 * process"; EPERM means "the process exists but you're not allowed
 * to signal it" (different uid). Both Start.ts and Stop.ts use this
 * via this single source of truth so the EPERM-as-alive semantics
 * stay aligned.
 */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
            return false;
        }
        // EPERM, EINVAL, anything unexpected — assume alive so we
        // don't accidentally take over an existing daemon's slot.
        return true;
    }
}

/**
 * Atomically claim ownership of the pidfile at `path` for this
 * process. Two start attempts that race here can never both
 * succeed: `flag: "wx"` opens with `O_EXCL`, so exactly one wins
 * and the other observes `EEXIST`.
 *
 * On `EEXIST`, inspect the file:
 * - **alive peer** → print a stderr line with `cli.sh stop` /
 *   `kill -9 <pid>` instructions, then `process.exit(1)`. The
 *   peer is left untouched.
 * - **stale or malformed** → log the cleanup, unlink, and retry
 *   the atomic write. Recovery from a daemon that crashed without
 *   removing its own pidfile is automatic.
 *
 * Logs warnings about cleanup go through `bootLog` (the stdout-only
 * pre-daemon logger) so the rolling file isn't touched before we
 * know we're alone.
 */
export function acquirePidFile(path: string, log: Logger): void {
    while (true) {
        try {
            writeFileSync(path, `${process.pid}\n`, { flag: "wx", encoding: "utf-8" });
            return;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
                throw err;
            }
        }
        const status = inspectPidFile(path);
        if (status.kind === "alive") {
            const message =
                `Another daemon is already running (pid=${status.pid}).\n` +
                `  Drain it cleanly:    ./cli.sh stop\n` +
                `  Force a wedged one:  kill -9 ${status.pid}\n`;
            process.stderr.write(message);
            process.exit(1);
        }
        if (status.kind === "stale") {
            log.warn(`removed stale pidfile (pid=${status.pid} no longer running)`);
        } else if (status.kind === "malformed") {
            log.warn(`removed malformed pidfile`);
        }
        // "vacant" can happen if a peer cleaned up between EEXIST
        // and inspect — fall through and retry the wx write.
        try {
            unlinkSync(path);
        } catch {
            // ignore — racing peer may have removed it
        }
    }
}

/**
 * Best-effort unlink of the pidfile during shutdown. ENOENT is
 * ignored so a clean shutdown after a stop sequence that already
 * removed the file doesn't error.
 */
export function removePidFile(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // ignore
    }
}
