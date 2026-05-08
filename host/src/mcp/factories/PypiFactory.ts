import { mkdirSync } from "node:fs";
import type { Logger } from "effective-assistant-shared";
import { SHARED_NETWORK_NAME } from "../../DockerTools.js";
import { createMcpFileSink, type McpFileSink } from "../../tools/LogRetentionTools.js";
import type { McpEntry } from "../McpEntry.js";
import type { McpServerFactory } from "../McpServerFactory.js";
import { mcpMountDirFor, PYPI_RUNTIME_IMAGE } from "../RuntimeImages.js";
import type { McpTransport } from "../transports/McpTransport.js";
import { StdioMcpTransport } from "../transports/StdioMcpTransport.js";

/** Configuration for {@link PypiFactory}. */
export interface PypiFactoryConfig {
    /** Logger used by transports for spawn/exit/error events. */
    readonly log: Logger;
    /** Per-MCP log directory (`data/logs/mcp/`). */
    readonly mcpLogsDir: string;
    /** Days of rotated log retention. */
    readonly logRetentionDays: number;
    /** Project-root `tmp/` (see `Bootstrap.tmpDir`). */
    readonly tmpDir: string;
    /** UID and GID for `--user`; written by daemon-uid into `/work`. */
    readonly hostUid: number;
    readonly hostGid: number;
}

/**
 * Build the `docker run` argv for a pypi-source MCP. Composes
 * `<package>[==<version>] [args...]` against the shared
 * `ea-mcp-runtime-pypi` image (entrypoint `uvx`).
 *
 * Layout matches {@link NpmFactory}'s with two differences: the
 * runtime image tag and the version separator (`==` per PEP 508).
 *
 * `entry.command` is ignored — see the matching note in NpmFactory.
 */
function dockerArgsForEntry(entry: McpEntry, config: PypiFactoryConfig): string[] {
    if (entry.package === undefined) {
        throw new Error(`MCP "${entry.id}": pypi source requires a "package" field.`);
    }

    const args: string[] = [
        "run",
        "-i",
        "--rm",
        "--name",
        `ea-mcp-${entry.id}`,
        "--user",
        `${config.hostUid}:${config.hostGid}`,
    ];

    if (entry.network.disable) {
        args.push("--network", "none");
    } else {
        args.push("--network", SHARED_NETWORK_NAME);
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

    for (const a of entry.args) {
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
            dockerArgs: dockerArgsForEntry(entry, this.config),
            idleTimeoutSeconds: entry.idleTimeoutSeconds,
            log: this.config.log.child({ mcp: entry.id }),
            openFileSink,
        });
    }
}
