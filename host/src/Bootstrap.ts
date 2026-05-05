import { resolve } from "node:path";

/**
 * Single source of truth for filesystem paths and required env vars.
 *
 * Built on demand inside each command's `run()` so that `--help` and
 * other introspective commands don't touch the filesystem or env. Each
 * command calls {@link Bootstrap.requireEnv} only for the variables it
 * actually needs — `stop` and `chat`, for example, work without
 * `POSTGRES_PASSWORD` set.
 */
export interface Bootstrap {
    readonly dataDir: string;
    readonly pidFile: string;
    readonly postgresPortFile: string;
    readonly workspaceDir: string;
    /**
     * Absolute host path of `data/workspace-template/`. Copied into
     * {@link workspaceDir} on daemon start (before plugin templates so
     * that the global defaults win on overlaps). Versioned with the
     * repo; users edit it directly to seed their workspace.
     */
    readonly workspaceTemplateDir: string;
    readonly postgresDataDir: string;
    /**
     * Directory under `dataDir` that pino-roll writes daily-rotated
     * `ea.YYYYMMDD.<n>.log` files into. Created on demand by the
     * daemon's `start` command.
     */
    readonly logsDir: string;
    /**
     * Number of rolled-over log files kept beyond the active one.
     * Sourced from `LOG_RETENTION_DAYS`; falls back to 7.
     */
    readonly logRetentionDays: number;
    /**
     * Absolute host path of `container/src/`. Bind-mounted into the
     * agent container at `/app/src` so tsx-watch picks up edits
     * without an image rebuild.
     */
    readonly containerSrcDir: string;
    /**
     * Read `process.env[name]` or throw a clear actionable error.
     *
     * @throws If the variable is unset or empty.
     */
    requireEnv(name: string): string;
}

/**
 * Build the singleton {@link Bootstrap} object. The data directory is
 * resolved relative to the compiled JS location: `host/build/Bootstrap.js`
 * lives two levels under the project root, so `data/` is at
 * `__dirname/../../data`.
 */
export function bootstrap(): Bootstrap {
    const dataDir = resolve(__dirname, "../../data");
    const containerSrcDir = resolve(__dirname, "../../container/src");
    return Object.freeze({
        dataDir,
        pidFile: `${dataDir}/.daemon.pid`,
        postgresPortFile: `${dataDir}/.postgres-port`,
        workspaceDir: `${dataDir}/workspace`,
        workspaceTemplateDir: `${dataDir}/workspace-template`,
        postgresDataDir: `${dataDir}/postgres`,
        logsDir: `${dataDir}/logs`,
        logRetentionDays: parseRetention(process.env.LOG_RETENTION_DAYS),
        containerSrcDir,
        requireEnv,
    });
}

/** Parse `LOG_RETENTION_DAYS` to a positive integer, defaulting to 7. */
function parseRetention(raw: string | undefined): number {
    if (!raw) {
        return 7;
    }
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(
            `LOG_RETENTION_DAYS must be a positive integer, got ${JSON.stringify(raw)}`,
        );
    }
    return n;
}

/**
 * Read a required environment variable.
 *
 * @throws If the variable is unset or an empty string.
 */
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is not set. Add it to .env at the repo root.`);
    }
    return value;
}
