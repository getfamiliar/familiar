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
     * `ea.YYYYMMDD.<n>.log` files into. Created on demand by the
     * daemon's `start` command.
     */
    readonly logsDir: string;
    /**
     * Absolute host path of `container/src/`. Bind-mounted into the
     * agent container at `/app/src` so tsx-watch picks up edits
     * without an image rebuild.
     */
    readonly containerSrcDir: string;
    /**
     * Absolute host path of the YAML config file (`config/config.yml`).
     * The file itself is gitignored; `config/config.example.yml` is the
     * tracked sample. Pass this into `HostConfigService` and
     * `lintConfigFile` from any command that needs configured values.
     */
    readonly configFile: string;
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
    return Object.freeze({
        dataDir,
        pidFile: `${dataDir}/.daemon.pid`,
        postgresPortFile: `${dataDir}/.postgres-port`,
        workspaceDir: `${dataDir}/workspace`,
        workspaceTemplateDir: `${dataDir}/workspace-template`,
        postgresDataDir: `${dataDir}/postgres`,
        logsDir: `${dataDir}/logs`,
        containerSrcDir,
        configFile: `${projectRoot}/config/config.yml`,
    });
}
