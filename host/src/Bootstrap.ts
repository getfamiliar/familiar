import { resolve } from "node:path";

/**
 * Single source of truth for filesystem paths the host needs at
 * runtime. Built on demand inside each command's `run()` so that
 * `--help` and other introspective commands don't touch the
 * filesystem.
 *
 * Environment-variable handling and required-setting validation no
 * longer live here — both moved to the YAML-backed `ConfigService`
 * (see `host/src/config/`). Commands that need configured values
 * instantiate `HostConfigService(boot.configFile)` and read via the
 * typed accessors.
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
     * `familiar.YYYYMMDD.<n>.log` files into. Created on demand by the
     * daemon's `start` command.
     */
    readonly logsDir: string;
    /**
     * Per-MCP log directory at `data/logs/mcp/`. Each declared MCP
     * gets its own daily-rotated `<id>.YYYYMMDD.<n>.log` here for
     * raw stdio capture. Created on demand by the daemon's `start`
     * command alongside {@link logsDir}.
     */
    readonly mcpLogsDir: string;
    /**
     * Absolute host path of `container/src/`. Bind-mounted into the
     * agent container at `/app/src` so tsx-watch picks up edits
     * without an image rebuild.
     */
    readonly containerSrcDir: string;
    /**
     * Absolute host path of `shared/build/`. Bind-mounted into the
     * agent container at `/shared/build` (read-only) so the
     * container resolves `@getfamiliar/shared` against the
     * host's just-rebuilt artifacts. `cli.sh` already rebuilds
     * `shared/build/` before the daemon starts, so by the time the
     * agent container boots this path is fresh.
     */
    readonly sharedBuildDir: string;
    /**
     * Absolute host path of the YAML config file (`config/config.yml`).
     * The file itself is gitignored; `config/config.example.yml` is the
     * tracked sample. Pass this into `HostConfigService` and
     * `lintConfigFile` from any command that needs configured values.
     */
    readonly configFile: string;
    /**
     * Absolute host path of the MCP-servers YAML file
     * (`config/mcp.yml`). Optional at runtime — when absent, no MCPs
     * run. The file is gitignored; `config/mcp.example.yml` is the
     * tracked sample. Read by the `McpRunner` and the `mcp lint`
     * subcommand.
     */
    readonly mcpConfigFile: string;
    /**
     * Project-root `tmp/` directory. Holds per-MCP bind-mount roots
     * (`tmp/mcp-mount-<id>/`) for npm/pypi runtime containers,
     * which double as `/work` (WORKDIR + HOME) so the npx/uv caches
     * persist across cold-spawn cycles. Gitignored; safe to
     * `rm -rf` whenever a clean slate is wanted.
     */
    readonly tmpDir: string;
    /**
     * Shared scratch directory at `tmp/scratch/`. Bind-mounted at
     * `/scratch/` into both the agent container and every MCP container,
     * so files staged here are visible to all of them under the same
     * absolute path. Plugins place per-event auxiliary files via
     * `ctx.events.emit({ files: [...] })`; the host writes them under
     * `<scratchDir>/<eventId>/` atomically with the event INSERT.
     * Subdirectories older than 24 h are swept by an hourly Croner job.
     */
    readonly scratchDir: string;
    /**
     * UID of the daemon process. Passed to docker as `--user` for
     * the npm/pypi runtime containers so files written into
     * `tmp/mcp-mount-<id>/` end up host-user-owned. Read once via
     * `process.getuid()`; Linux-only daemon, so always defined.
     */
    readonly hostUid: number;
    /** GID of the daemon process. See {@link hostUid}. */
    readonly hostGid: number;
}

/**
 * Build the singleton {@link Bootstrap} object. The data directory is
 * resolved relative to the compiled JS location: `host/build/Bootstrap.js`
 * lives two levels under the project root, so `data/` is at
 * `import.meta.dirname/../../data`.
 */
export function bootstrap(): Bootstrap {
    const projectRoot = resolve(import.meta.dirname, "../..");
    const dataDir = `${projectRoot}/data`;
    const containerSrcDir = `${projectRoot}/container/src`;
    const sharedBuildDir = `${projectRoot}/shared/build`;
    return Object.freeze({
        dataDir,
        pidFile: `${dataDir}/.daemon.pid`,
        postgresPortFile: `${dataDir}/.postgres-port`,
        workspaceDir: `${dataDir}/workspace`,
        workspaceTemplateDir: `${dataDir}/workspace-template`,
        postgresDataDir: `${dataDir}/postgres`,
        logsDir: `${dataDir}/logs`,
        mcpLogsDir: `${dataDir}/logs/mcp`,
        containerSrcDir,
        sharedBuildDir,
        configFile: `${projectRoot}/config/config.yml`,
        mcpConfigFile: `${projectRoot}/config/mcp.yml`,
        tmpDir: `${projectRoot}/tmp`,
        scratchDir: `${projectRoot}/tmp/scratch`,
        hostUid: process.getuid?.() ?? 0,
        hostGid: process.getgid?.() ?? 0,
    });
}
