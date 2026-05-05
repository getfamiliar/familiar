import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";

const POLL_INTERVAL_MS = 100;
const POLL_TICKS = 100; // 100 × 100 ms = 10 s grace period before SIGKILL.

/**
 * `ea stop` — send SIGTERM to the daemon read from the pidfile, wait up
 * to 10 s for graceful shutdown, then SIGKILL. Removes the pidfile in
 * every exit path. Mirrors the previous `cli/stop.sh` UX one-for-one.
 */
export const stopCommand = defineCommand({
    meta: {
        name: "stop",
        description: "Stop the host daemon (SIGTERM, then SIGKILL after 10 s).",
    },
    async run() {
        const boot = bootstrap();
        const pidFile = boot.pidFile;

        if (!existsSync(pidFile)) {
            console.error(`No pidfile at ${pidFile}; daemon is not running.`);
            return;
        }

        const raw = readFileSync(pidFile, "utf-8").trim();
        if (!raw) {
            console.error("Pidfile is empty; removing.");
            removeQuietly(pidFile);
            return;
        }

        const pid = Number.parseInt(raw, 10);
        if (!Number.isFinite(pid) || pid <= 0) {
            console.error(`Pidfile contains invalid pid ${raw}; removing.`);
            removeQuietly(pidFile);
            return;
        }

        if (!isProcessAlive(pid)) {
            console.error(`Pid ${pid} not running; removing stale pidfile.`);
            removeQuietly(pidFile);
            return;
        }

        console.error(`Sending SIGTERM to daemon pid ${pid}...`);
        try {
            process.kill(pid, "SIGTERM");
        } catch (err) {
            console.error(
                `Failed to send SIGTERM: ${err instanceof Error ? err.message : String(err)}`,
            );
            return;
        }

        for (let i = 0; i < POLL_TICKS; i += 1) {
            if (!isProcessAlive(pid)) {
                console.error("Daemon stopped.");
                removeQuietly(pidFile);
                return;
            }
            await sleep(POLL_INTERVAL_MS);
        }

        console.error("Daemon did not exit within 10s; sending SIGKILL.");
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // process may have just exited
        }
        removeQuietly(pidFile);
    },
});

/** Probe whether a process exists by sending signal 0 (which doesn't kill). */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Best-effort unlink that swallows ENOENT. */
function removeQuietly(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // ignore
    }
}

/** Promise-based setTimeout. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
