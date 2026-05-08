import { type Dirent, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { bootstrap } from "../../Bootstrap.js";
import { inspectPidFile } from "../pidfile.js";

/** Bind-mount directories the npm/pypi factories create — purge target. */
const MOUNT_DIR_PREFIX = "mcp-mount-";

/**
 * `ea mcp purge` — remove every `tmp/mcp-mount-*` directory. Refuses
 * while the daemon is up so we never yank a cache out from under a
 * live `ea-mcp-<id>` container reading from it.
 *
 * Out of scope: the daemon's general logs, `data/`, anything other
 * than the `mcp-mount-*` prefix. `tmp/` itself is left in place
 * because `Bootstrap.tmpDir` is expected to exist when the daemon
 * boots; the npm/pypi factories recreate per-id subdirs lazily.
 */
export const mcpPurgeCommand = defineCommand({
    meta: {
        name: "purge",
        description:
            "Remove all tmp/mcp-mount-* cache directories. Refuses to run while the daemon is up.",
    },
    run() {
        const boot = bootstrap();

        const status = inspectPidFile(boot.pidFile);
        if (status.kind === "alive") {
            process.stderr.write(
                `daemon is running (pid=${status.pid}); stop it first with ./cli.sh stop\n`,
            );
            process.exit(1);
        }

        if (!existsSync(boot.tmpDir)) {
            process.stdout.write("nothing to purge (tmp/ not present)\n");
            return;
        }

        const targets = readdirSync(boot.tmpDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith(MOUNT_DIR_PREFIX))
            .map((entry) => path.join(boot.tmpDir, entry.name));

        if (targets.length === 0) {
            process.stdout.write("nothing to purge (no tmp/mcp-mount-* directories found)\n");
            return;
        }

        let totalBytes = 0;
        for (const dir of targets) {
            totalBytes += dirSize(dir);
            rmSync(dir, { recursive: true, force: true });
            process.stdout.write(`removed ${dir}\n`);
        }

        process.stdout.write(
            `purged ${targets.length} mount director${targets.length === 1 ? "y" : "ies"} (~${formatBytes(totalBytes)} freed)\n`,
        );
    },
});

/**
 * Best-effort recursive size in bytes. Uses `withFileTypes` to avoid
 * an extra `lstat` per child, and follows directories without
 * dereferencing symlinks (size of the symlink itself, not the target).
 * Errors during traversal are swallowed — a half-readable tree should
 * still report something rather than crash the purge.
 */
function dirSize(dir: string): number {
    let total = 0;
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            total += dirSize(child);
            continue;
        }
        try {
            total += statSync(child).size;
        } catch {
            // ignore
        }
    }
    return total;
}

/**
 * Render a byte count as a short human-friendly string. Switches
 * units at 1024×; one decimal place above bytes.
 */
function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ["KB", "MB", "GB", "TB"] as const;
    let value = bytes / 1024;
    let unitIdx = 0;
    while (value >= 1024 && unitIdx < units.length - 1) {
        value /= 1024;
        unitIdx += 1;
    }
    return `${value.toFixed(1)} ${units[unitIdx]}`;
}
