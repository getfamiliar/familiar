import { mkdirSync } from "node:fs";
import type { Logger } from "@getfamiliar/shared";
import { SHARED_NETWORK_NAME } from "../../utils/DockerTools.js";
import { createMcpFileSink, type McpFileSink } from "../../utils/LogRetentionTools.js";
import type { McpEntry } from "../McpEntry.js";
import type { McpServerFactory } from "../McpServerFactory.js";
import { mcpMountDirFor, PYPI_RUNTIME_IMAGE } from "../RuntimeImages.js";
import type { McpTransport } from "../transports/McpTransport.js";
import { StdioMcpTransport } from "../transports/StdioMcpTransport.js";
import type { DockerArgsOptions, RuntimeContainerConfig } from "./DockerArgsOptions.js";
import { prepareOfflineMount } from "./OfflinePrepStamp.js";

/** Configuration for {@link PypiFactory}. */
export interface PypiFactoryConfig extends RuntimeContainerConfig {
    /** Logger used by transports for spawn/exit/error events. */
    readonly log: Logger;
    /** Per-MCP log directory (`data/logs/mcp/`). */
    readonly mcpLogsDir: string;
    /** Days of rotated log retention. */
    readonly logRetentionDays: number;
    /**
     * Id of the runtime image, resolved once the gateway ensured it.
     * Recorded in the prep stamp of offline entries so a rebuilt image
     * (e.g. a package-manager bump with a new cache layout) forces a
     * re-prep.
     */
    readonly resolveRuntimeImageId: () => string;
}

/**
 * Build the `docker run` argv for a pypi-source MCP. Composes
 * `<package>[==<version>] [extraArgs...]` against the shared
 * `familiar-mcp-runtime-pypi` image (entrypoint `uvx`).
 *
 * Layout matches {@link buildNpmDockerArgs}'s with two differences:
 * the runtime image tag and the version separator (`==` per PEP
 * 508). `options` semantics are identical — see the doc on the
 * npm helper for how `interactive`, `containerName`, and
 * `appendArgs` interact with the bastion defaults.
 *
 * When `entry.command` is set, the package and command are split
 * via `uvx --from <pkg>[==<ver>] <command>` — required when the
 * published executable name differs from the package name (e.g.
 * package `iflow-mcp_ctvidic-whoop-mcp-server` ships a
 * `whoop-mcp-server` entry point). `entry.args` and `appendArgs`
 * then act as the command's CLI args.
 */
export function buildPypiDockerArgs(
    entry: McpEntry,
    config: RuntimeContainerConfig,
    options: DockerArgsOptions = {},
): string[] {
    if (entry.package === undefined) {
        throw new Error(`MCP "${entry.id}": pypi source requires a "package" field.`);
    }

    const containerName =
        options.containerName === undefined ? `familiar-mcp-${entry.id}` : options.containerName;
    const interactive = options.interactive ?? false;

    const args: string[] = ["run", interactive ? "-it" : "-i", "--rm"];
    if (containerName !== null) {
        args.push("--name", containerName);
    }
    args.push("--user", `${config.hostUid}:${config.hostGid}`);

    if (entry.network.disable) {
        args.push("--network", "none");
    } else {
        args.push("--network", SHARED_NETWORK_NAME);
        // See the matching comment in NpmFactory: `familiar-net` is
        // IPv4-only but docker's embedded DNS still hands out AAAA
        // records, which Python's `getaddrinfo` would happily try
        // and fail on. Disabling IPv6 in-kernel filters those out.
        args.push("--sysctl", "net.ipv6.conf.all.disable_ipv6=1");
    }

    args.push("-v", `${mcpMountDirFor(config.tmpDir, entry.id)}:/work`);
    // Shared scratch dir; see NpmFactory for the rationale.
    args.push("-v", `${config.scratchDir}:/scratch`);

    for (const env of entry.env) {
        args.push("-e", `${env.name}=${env.value}`);
    }
    for (const volume of entry.volumes) {
        args.push("-v", volume);
    }

    args.push(PYPI_RUNTIME_IMAGE);

    // Network-disabled phase-2: tell uv to skip the index entirely
    // and serve the package from the warm cache populated by prep.
    // Without this, uvx still resolves the package version against
    // PyPI on every cold spawn, and a `--network none` container
    // hangs on DNS until uv times out.
    if (entry.network.disable) {
        args.push("--offline");
    }

    const versionSuffix = entry.version === undefined ? "" : `==${entry.version}`;
    if (entry.command === null) {
        args.push(`${entry.package}${versionSuffix}`);
    } else {
        args.push("--from", `${entry.package}${versionSuffix}`, entry.command);
    }

    // mcp.yml args always apply; user-supplied `appendArgs` tail them.
    for (const a of entry.args) {
        args.push(a);
    }
    for (const a of options.appendArgs ?? []) {
        args.push(a);
    }

    return args;
}

/**
 * Build a `docker run` argv that pre-populates the per-MCP `/work`
 * cache with the pypi package, but does **not** start the MCP server.
 * Counterpart of {@link buildNpmPrepDockerArgs}; same rationale and
 * same shape — full network + IPv6 sysctl regardless of entry policy,
 * no user env vars, no user volumes, anonymous container.
 *
 * The entrypoint is overridden to `uvx --from <pkg>[==<ver>] python
 * -c ""`, which builds a temp environment containing the package and
 * runs an inline no-op. The download lands in `tmp/mcp-mount-<id>/`
 * (uv's `.cache/uv/` and `.local/share/uv/` under HOME=/work), the
 * same paths phase-2 `uvx <pkg>` consults.
 */
export function buildPypiPrepDockerArgs(entry: McpEntry, config: RuntimeContainerConfig): string[] {
    if (entry.package === undefined) {
        throw new Error(`MCP "${entry.id}": pypi source requires a "package" field.`);
    }
    const versionSuffix = entry.version === undefined ? "" : `==${entry.version}`;
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
        "uvx",
        PYPI_RUNTIME_IMAGE,
        "--from",
        `${entry.package}${versionSuffix}`,
        "python",
        "-c",
        "",
    ];
}

/**
 * Factory for `source: pypi`. Produces a {@link StdioMcpTransport}
 * that runs `uvx <package>` inside the shared
 * `familiar-mcp-runtime-pypi` image. The runtime image must already exist
 * (the gateway calls `ensureRuntimeImage("pypi", …)` at start before
 * any factory is invoked).
 */
export class PypiFactory implements McpServerFactory {
    private readonly config: PypiFactoryConfig;

    constructor(config: PypiFactoryConfig) {
        this.config = config;
    }

    create(entry: McpEntry): McpTransport {
        // Offline entries get their package cache prepped with full
        // network before the first phase-2 spawn — once per cache
        // lifetime. A cache whose prep stamp no longer matches the
        // entry or runtime image is wiped first, never re-prepped in
        // place: rerunning uvx with full network would let the
        // package's build hooks exfiltrate anything the offline phase-2 run
        // had stashed in /work. Online entries resolve packages
        // themselves; their mount dir (which may hold login state) is
        // never wiped.
        const mountDir = mcpMountDirFor(this.config.tmpDir, entry.id);
        const offlineMount = entry.network.disable
            ? prepareOfflineMount(
                  entry,
                  this.config.tmpDir,
                  this.config.resolveRuntimeImageId(),
                  this.config.log,
              )
            : undefined;
        if (offlineMount === undefined) {
            mkdirSync(mountDir, { recursive: true });
        }
        const isPrepNeeded = offlineMount?.isPrepNeeded === true;

        const { mcpLogsDir, logRetentionDays } = this.config;
        const openFileSink = (): Promise<McpFileSink> =>
            createMcpFileSink(mcpLogsDir, entry.id, logRetentionDays);
        const prepDockerArgs = isPrepNeeded
            ? buildPypiPrepDockerArgs(entry, this.config)
            : undefined;
        return new StdioMcpTransport({
            id: entry.id,
            title: entry.title,
            description: entry.description,
            dockerArgs: buildPypiDockerArgs(entry, this.config),
            prepDockerArgs,
            onPrepSuccess: isPrepNeeded ? offlineMount?.writeStamp : undefined,
            mountDir,
            idleTimeoutSeconds: entry.idleTimeoutSeconds,
            log: this.config.log.child({ mcp: entry.id }),
            openFileSink,
        });
    }
}
