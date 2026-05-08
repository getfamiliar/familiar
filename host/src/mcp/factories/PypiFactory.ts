import { mkdirSync } from "node:fs";
import type { Logger } from "effective-assistant-shared";
import { SHARED_NETWORK_NAME } from "../../DockerTools.js";
import { createMcpFileSink, type McpFileSink } from "../../tools/LogRetentionTools.js";
import type { McpEntry } from "../McpEntry.js";
import type { McpServerFactory } from "../McpServerFactory.js";
import { mcpMountDirFor, PYPI_RUNTIME_IMAGE } from "../RuntimeImages.js";
import type { McpTransport } from "../transports/McpTransport.js";
import { StdioMcpTransport } from "../transports/StdioMcpTransport.js";
import type { DockerArgsOptions, RuntimeContainerConfig } from "./DockerArgsOptions.js";

/** Configuration for {@link PypiFactory}. */
export interface PypiFactoryConfig extends RuntimeContainerConfig {
    /** Logger used by transports for spawn/exit/error events. */
    readonly log: Logger;
    /** Per-MCP log directory (`data/logs/mcp/`). */
    readonly mcpLogsDir: string;
    /** Days of rotated log retention. */
    readonly logRetentionDays: number;
}

/**
 * Build the `docker run` argv for a pypi-source MCP. Composes
 * `<package>[==<version>] [extraArgs...]` against the shared
 * `ea-mcp-runtime-pypi` image (entrypoint `uvx`).
 *
 * Layout matches {@link buildNpmDockerArgs}'s with two differences:
 * the runtime image tag and the version separator (`==` per PEP
 * 508). `options` semantics are identical — see the doc on the
 * npm helper for how `interactive`, `containerName`, and
 * `extraArgs` interact with the bastion defaults.
 *
 * `entry.command` is ignored — see the matching note in NpmFactory.
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
        // See the matching comment in NpmFactory: `ea-net` is
        // IPv4-only but docker's embedded DNS still hands out AAAA
        // records, which Python's `getaddrinfo` would happily try
        // and fail on. Disabling IPv6 in-kernel filters those out.
        args.push("--sysctl", "net.ipv6.conf.all.disable_ipv6=1");
    }

    args.push("-v", `${mcpMountDirFor(config.tmpDir, entry.id)}:/work`);

    for (const env of entry.env) {
        args.push("-e", `${env.name}=${env.value}`);
    }
    for (const volume of entry.volumes) {
        args.push("-v", volume);
    }

    args.push(PYPI_RUNTIME_IMAGE);

    const versionSuffix = entry.version === undefined ? "" : `==${entry.version}`;
    args.push(`${entry.package}${versionSuffix}`);

    for (const a of extraArgs) {
        args.push(a);
    }

    return args;
}

/**
 * Factory for `source: pypi`. Produces a {@link StdioMcpTransport}
 * that runs `uvx <package>` inside the shared
 * `ea-mcp-runtime-pypi` image. The runtime image must already exist
 * (the gateway calls `ensureRuntimeImage("pypi", …)` at start before
 * any factory is invoked).
 */
export class PypiFactory implements McpServerFactory {
    private readonly config: PypiFactoryConfig;

    constructor(config: PypiFactoryConfig) {
        this.config = config;
    }

    create(entry: McpEntry): McpTransport {
        mkdirSync(mcpMountDirFor(this.config.tmpDir, entry.id), { recursive: true });

        const { mcpLogsDir, logRetentionDays } = this.config;
        const openFileSink = (): Promise<McpFileSink> =>
            createMcpFileSink(mcpLogsDir, entry.id, logRetentionDays);
        return new StdioMcpTransport({
            id: entry.id,
            title: entry.title,
            description: entry.description,
            dockerArgs: buildPypiDockerArgs(entry, this.config),
            idleTimeoutSeconds: entry.idleTimeoutSeconds,
            log: this.config.log.child({ mcp: entry.id }),
            openFileSink,
        });
    }
}
