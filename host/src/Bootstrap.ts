import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

/**
 * Single source of truth for filesystem paths the host needs at
 * runtime. Built on demand inside each command's `run()` so that
 * `--help` and other introspective commands don't touch the
 * filesystem.
 *
 * Two distinct roots feed the paths below, deliberately kept separate:
 * {@link homeDir} (the user's project folder — data, tmp, config) and
 * {@link assetRoot} (the installed `@getfamiliar/host` package — its own
 * version and packaged template assets). In a monorepo checkout the two
 * coincide at the repo root; once installed via npm they diverge, which
 * is what lets a user run Familiar out of any folder.
 *
 * Environment-variable handling and required-setting validation no
 * longer live here — both moved to the YAML-backed `ConfigService`
 * (see `host/src/config/`). Commands that need configured values
 * instantiate `HostConfigService(boot.configFile)` and read via the
 * typed accessors.
 */
export interface Bootstrap {
    /**
     * The user's project folder — `process.env.FAMILIAR_HOME ?? process.cwd()`.
     * Holds `config/`, `data/`, `tmp/`. Every user-data path below is
     * rooted here, so `familiar` can run out of any initialized folder
     * (e.g. `~/familiar`). In a dev checkout `cli.sh` exports
     * `FAMILIAR_HOME="$ROOT"` so this equals the repo root.
     */
    readonly homeDir: string;
    /**
     * Root of the installed `@getfamiliar/host` package
     * (`host/build/Bootstrap.js` → `..`). Used to read the host's own
     * version and to locate packaged `template/` assets consumed by
     * `familiar init`. Independent of {@link homeDir} once installed.
     */
    readonly assetRoot: string;
    /**
     * The host package's own version (from `assetRoot/package.json`). Used
     * to pin the `familiar` dependency that `familiar init` scaffolds, and
     * as the default {@link imageTag} so a CLI release pulls the matching
     * image built in the same CI run.
     */
    readonly version: string;
    readonly dataDir: string;
    /**
     * Pidfile written by the daemon and consumed by `./cli.sh stop`.
     * Lives under `tmp/` because it's only meaningful while the daemon
     * is alive; safe to delete when the daemon isn't running.
     */
    readonly pidFile: string;
    /**
     * File recording the loopback host port that `familiar-postgres`
     * is published on. Lives under `tmp/` because it's only meaningful
     * while the postgres container is up; rewritten on each
     * `./cli.sh start`.
     */
    readonly postgresPortFile: string;
    /**
     * LLM debug-capture directory written by `ReverseProxy` when
     * `inference.captureModelHttpRequestBodies` is on. Ephemeral,
     * gitignored, safe to wipe.
     */
    readonly llmDebugDir: string;
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
     * How the daemon obtains its Docker images. `"build"` (dev /
     * monorepo) builds them locally from the checkout; `"pull"` (default
     * for installed instances) pulls prebuilt, version-tagged images from
     * {@link imageRegistry}. Defaults to `"build"` in dev mode
     * ({@link isDevMode}), else `"pull"`, overridable via
     * `FAMILIAR_IMAGE_MODE`.
     */
    readonly imageMode: "build" | "pull";
    /**
     * Registry namespace prefix for pulled images, e.g.
     * `ghcr.io/getfamiliar`. Combined with the image's published name and
     * {@link imageTag} to form a pull reference. Overridable via
     * `FAMILIAR_IMAGE_REGISTRY` (mirrors, air-gapped registries).
     */
    readonly imageRegistry: string;
    /**
     * Tag pulled in `"pull"` mode. Defaults to the host package's own
     * version so a given CLI release always pulls the matching image
     * built in the same CI run. Overridable via `FAMILIAR_IMAGE_TAG`.
     */
    readonly imageTag: string;
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
 * True when the daemon is running in dev mode, signalled by the
 * `FAMILIAR_DEV` env var being `1` or `true` (case-insensitive).
 * `cli.sh` reads the same variable to pick its rebuild policy and
 * node flags; the host side uses it to raise the default log level
 * and turn on the inference debug captures when the operator hasn't
 * pinned them explicitly. Production (unset) is the default — deployed
 * environments shouldn't have to opt out.
 */
export function isDevMode(): boolean {
    const v = process.env.FAMILIAR_DEV?.toLowerCase();
    return v === "1" || v === "true";
}

/**
 * Read the host package's own version from its `package.json`
 * (`assetRoot/package.json`). Resolved relative to this module so it
 * works both in a monorepo checkout and once installed under
 * `node_modules/@getfamiliar/host`.
 *
 * @returns the `version` string from the host package manifest.
 */
function readHostVersion(): string {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version: string };
    return pkg.version;
}

/**
 * Resolve the image-acquisition mode. Dev/monorepo defaults to building
 * locally; installed instances default to pulling prebuilt images. An
 * explicit `FAMILIAR_IMAGE_MODE` of `build` or `pull` overrides either
 * default (e.g. a prod user who customizes `python.packages` sets
 * `build`).
 *
 * @returns `"build"` or `"pull"`.
 */
function resolveImageMode(): "build" | "pull" {
    const override = process.env.FAMILIAR_IMAGE_MODE?.toLowerCase();
    if (override === "build" || override === "pull") {
        return override;
    }
    return isDevMode() ? "build" : "pull";
}

/**
 * Build the singleton {@link Bootstrap} object. User-data paths are
 * rooted at {@link Bootstrap.homeDir} (`FAMILIAR_HOME` or the current
 * working directory); package assets and the host version are resolved
 * relative to this compiled module's location
 * ({@link Bootstrap.assetRoot}). In a dev checkout the two coincide at
 * the repo root because `cli.sh` exports `FAMILIAR_HOME="$ROOT"`.
 */
export function bootstrap(): Bootstrap {
    const homeDir = process.env.FAMILIAR_HOME ?? process.cwd();
    const assetRoot = resolve(import.meta.dirname, "..");
    const version = readHostVersion();
    const dataDir = `${homeDir}/data`;
    const tmpDir = `${homeDir}/tmp`;
    const containerSrcDir = `${homeDir}/container/src`;
    const sharedBuildDir = `${homeDir}/shared/build`;
    return Object.freeze({
        homeDir,
        assetRoot,
        version,
        dataDir,
        pidFile: `${tmpDir}/.daemon.pid`,
        postgresPortFile: `${tmpDir}/.postgres-port`,
        llmDebugDir: `${tmpDir}/llm-debug`,
        workspaceDir: `${dataDir}/workspace`,
        workspaceTemplateDir: `${dataDir}/workspace-template`,
        postgresDataDir: `${dataDir}/postgres`,
        logsDir: `${dataDir}/logs`,
        mcpLogsDir: `${dataDir}/logs/mcp`,
        containerSrcDir,
        sharedBuildDir,
        configFile: `${homeDir}/config/config.yml`,
        mcpConfigFile: `${homeDir}/config/mcp.yml`,
        tmpDir,
        scratchDir: `${tmpDir}/scratch`,
        imageMode: resolveImageMode(),
        imageRegistry: process.env.FAMILIAR_IMAGE_REGISTRY ?? "ghcr.io/getfamiliar",
        imageTag: process.env.FAMILIAR_IMAGE_TAG ?? version,
        hostUid: process.getuid?.() ?? 0,
        hostGid: process.getgid?.() ?? 0,
    });
}

/**
 * Assert that {@link Bootstrap.homeDir} points at an initialized
 * Familiar project — i.e. `config/config.yml` exists. Every command
 * except `familiar init` calls this first, replacing the config-existence
 * gate that used to live in `cli.sh`.
 *
 * @param boot the bootstrap object whose {@link Bootstrap.homeDir} to check.
 * @throws Error when `config/config.yml` is absent under the home dir.
 */
export function requireHomeDir(boot: Bootstrap): void {
    if (existsSync(boot.configFile)) {
        return;
    }
    throw new Error(
        `${boot.homeDir} is not an initialized Familiar project (no config/config.yml). ` +
            `Run 'familiar init' here, or set FAMILIAR_HOME to your project folder.`,
    );
}

/**
 * Resolve the Docker reference for one of Familiar's images. In
 * `"build"` mode the daemon builds and tags images locally, so the plain
 * local name is returned; in `"pull"` mode the registry-qualified,
 * version-tagged reference is returned so the matching prebuilt image is
 * pulled. The image name is used verbatim both as the local tag and as
 * the name under {@link Bootstrap.imageRegistry}.
 *
 * @param boot bootstrap providing image mode, registry, and tag.
 * @param imageName the image's name (e.g. `familiar-agent`).
 * @returns the reference to pass to `docker run` / `docker pull`.
 */
export function imageRef(boot: Bootstrap, imageName: string): string {
    if (boot.imageMode === "build") {
        return imageName;
    }
    return `${boot.imageRegistry}/${imageName}:${boot.imageTag}`;
}
