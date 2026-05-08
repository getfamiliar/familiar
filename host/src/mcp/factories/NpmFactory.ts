import { mkdirSync } from "node:fs";
import type { Logger } from "effective-assistant-shared";
import { SHARED_NETWORK_NAME } from "../../DockerTools.js";
import { createMcpFileSink, type McpFileSink } from "../../tools/LogRetentionTools.js";
import type { McpEntry } from "../McpEntry.js";
import type { McpServerFactory } from "../McpServerFactory.js";
import { mcpMountDirFor, NPM_RUNTIME_IMAGE } from "../RuntimeImages.js";
import type { McpTransport } from "../transports/McpTransport.js";
import { StdioMcpTransport } from "../transports/StdioMcpTransport.js";
import type { DockerArgsOptions, RuntimeContainerConfig } from "./DockerArgsOptions.js";

/** Configuration for {@link NpmFactory}. */
export interface NpmFactoryConfig extends RuntimeContainerConfig {
    /** Logger used by transports for spawn/exit/error events. */
    readonly log: Logger;
    /** Per-MCP log directory (`data/logs/mcp/`). */
    readonly mcpLogsDir: string;
    /** Days of rotated log retention. */
    readonly logRetentionDays: number;
}

/**
 * Build the `docker run` argv for an npm-source MCP. Composes
 * `<package>[@<version>] [extraArgs...]` against the shared
 * `ea-mcp-runtime-npm` image (entrypoint `npx -y`).
 *
 * Default layout (no `options` passed):
 *   run -i --rm --name ea-mcp-<id> --network <net>
 *     --user <uid>:<gid>
 *     -v <tmpDir>/mcp-mount-<id>:/work
 *     [-e KEY=VAL ...]
 *     [-v HOST:CONTAINER[:ro] ...]
 *     ea-mcp-runtime-npm
 *     <package>[@<version>] [entry.args...]
 *
 * `options` lets one-shot callers (e.g. `./cli.sh mcp call`)
 * tweak the bastion defaults: `interactive: true` adds `-t`,
 * `containerName: null` drops `--name` so the call doesn't
 * collide with a live bastion-managed container of the same id,
 * and `extraArgs` overrides `entry.args` so the user can pass
 * `--login` (or any other CLI invocation) verbatim.
 *
 * The `entry.command` field is ignored for npm sources — the entry
 * point is fixed to `npx -y` to keep the runtime image's contract
 * predictable. Users who need a custom entrypoint should pick the
 * `docker-mcp-registry` source with their own image.
 */
export function buildNpmDockerArgs(
    entry: McpEntry,
    config: RuntimeContainerConfig,
    options: DockerArgsOptions = {},
): string[] {
    if (entry.package === undefined) {
        throw new Error(`MCP "${entry.id}": npm source requires a "package" field.`);
    }

    const containerName =
        options.containerName === undefined ? `ea-mcp-${entry.id}` : options.containerName;
    const interactive = options.interactive ?? false;
    const extraArgs = options.extraArgs ?? entry.args;

    const args: string[] = ["run", interactive ? "-it" : "-i", "--rm"];
    if (containerName !== null) {
        args.push("--name", containerName);
    }
    args.push("--user", `${config.hostUid}:${config.hostGid}`);

    if (entry.network.disable) {
        args.push("--network", "none");
    } else {
        args.push("--network", SHARED_NETWORK_NAME);
        // Hard-disable IPv6 inside the container. `ea-net` is IPv4-
        // only at the network level, but docker's embedded DNS
        // (127.0.0.11) returns AAAA records anyway for hosts that
        // publish both — and Node's `getaddrinfo` happily attempts
        // those v6 addresses before failing. Without this sysctl,
        // calls to e.g. `login.microsoftonline.com` surface as a
        // generic "Network request failed" because every connect
        // attempt hits ENETUNREACH on the v6 address. Setting
        // `net.ipv6.conf.all.disable_ipv6=1` in the container's
        // kernel makes `getaddrinfo` filter AAAA out before the
        // app sees it.
        args.push("--sysctl", "net.ipv6.conf.all.disable_ipv6=1");
    }

    // Mandatory `/work` mount comes first so a user-declared
    // overlapping `volumes:` entry layers on top — by docker's
    // own semantics, last `-v` wins. Documented as a footgun.
    args.push("-v", `${mcpMountDirFor(config.tmpDir, entry.id)}:/work`);

    for (const env of entry.env) {
        args.push("-e", `${env.name}=${env.value}`);
    }
    for (const volume of entry.volumes) {
        args.push("-v", volume);
    }

    args.push(NPM_RUNTIME_IMAGE);

    const versionSuffix = entry.version === undefined ? "" : `@${entry.version}`;
    args.push(`${entry.package}${versionSuffix}`);

    for (const a of extraArgs) {
        args.push(a);
    }

    return args;
}

/**
 * Build a `docker run` argv that pre-populates the per-MCP `/work`
 * cache with the npm package, but does **not** start the MCP server.
 * Used for network-restricted entries (`network.disable: true` or
 * non-empty `allowHosts`) whose phase-2 container can't reach the
 * registry. Forces full network and IPv6 sysctl regardless of the
 * entry's network policy, drops user env vars and user volumes, and
 * runs anonymously (no `--name`) so it can't collide with the live
 * `ea-mcp-<id>` container.
 *
 * The entrypoint is overridden to `npx -y --package <pkg>[@<ver>] --
 * node -e ""` — npx fetches and installs the package, then runs an
 * inline no-op and exits 0. The cache populated lives in
 * `tmp/mcp-mount-<id>/.npm/_npx/`, the same path the phase-2
 * `npx -y <pkg>` consults.
 */
export function buildNpmPrepDockerArgs(entry: McpEntry, config: RuntimeContainerConfig): string[] {
    if (entry.package === undefined) {
        throw new Error(`MCP "${entry.id}": npm source requires a "package" field.`);
    }
    const versionSuffix = entry.version === undefined ? "" : `@${entry.version}`;
    return [
        "run",
        "--rm",
        "--user",
        `${config.hostUid}:${config.hostGid}`,
        "--network",
        SHARED_NETWORK_NAME,
        "--sysctl",
        "net.ipv6.conf.all.disable_ipv6=1",
        "-v",
        `${mcpMountDirFor(config.tmpDir, entry.id)}:/work`,
        "--entrypoint",
        "npx",
        NPM_RUNTIME_IMAGE,
        "-y",
        "--package",
        `${entry.package}${versionSuffix}`,
        "--",
        "node",
        "-e",
        "",
    ];
}

/**
 * Factory for `source: npm`. Produces a {@link StdioMcpTransport}
 * that runs `npx -y <package>` inside the shared
 * `ea-mcp-runtime-npm` image. The runtime image must already exist
 * (the gateway calls `ensureRuntimeImage("npm", …)` at start before
 * any factory is invoked).
 */
export class NpmFactory implements McpServerFactory {
    private readonly config: NpmFactoryConfig;

    constructor(config: NpmFactoryConfig) {
        this.config = config;
    }

    create(entry: McpEntry): McpTransport {
        // Pre-create the per-id mount directory as the host user
        // so docker doesn't auto-create it as root the first time
        // the container starts. Idempotent.
        mkdirSync(mcpMountDirFor(this.config.tmpDir, entry.id), { recursive: true });

        const { mcpLogsDir, logRetentionDays } = this.config;
        const openFileSink = (): Promise<McpFileSink> =>
            createMcpFileSink(mcpLogsDir, entry.id, logRetentionDays);
        const isNetworkRestricted = entry.network.disable || entry.network.allowHosts.length > 0;
        const prepDockerArgs = isNetworkRestricted
            ? buildNpmPrepDockerArgs(entry, this.config)
            : undefined;
        return new StdioMcpTransport({
            id: entry.id,
            title: entry.title,
            description: entry.description,
            dockerArgs: buildNpmDockerArgs(entry, this.config),
            prepDockerArgs,
            idleTimeoutSeconds: entry.idleTimeoutSeconds,
            log: this.config.log.child({ mcp: entry.id }),
            openFileSink,
        });
    }
}
