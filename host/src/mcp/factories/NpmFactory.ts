import { mkdirSync } from "node:fs";
import type { Logger } from "effective-assistant-shared";
import { SHARED_NETWORK_NAME } from "../../DockerTools.js";
import { createMcpFileSink, type McpFileSink } from "../../tools/LogRetentionTools.js";
import type { McpEntry } from "../McpEntry.js";
import type { McpServerFactory } from "../McpServerFactory.js";
import { mcpMountDirFor, NPM_RUNTIME_IMAGE } from "../RuntimeImages.js";
import type { McpTransport } from "../transports/McpTransport.js";
import { StdioMcpTransport } from "../transports/StdioMcpTransport.js";

/** Configuration for {@link NpmFactory}. */
export interface NpmFactoryConfig {
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
 * Build the `docker run` argv for an npm-source MCP. Composes
 * `<package>[@<version>] [args...]` against the shared
 * `ea-mcp-runtime-npm` image (entrypoint `npx -y`).
 *
 * Layout:
 *   run -i --rm --name ea-mcp-<id> --network <net>
 *     --user <uid>:<gid>
 *     -v <tmpDir>/mcp-mount-<id>:/work
 *     [-e KEY=VAL ...]
 *     [-v HOST:CONTAINER[:ro] ...]
 *     ea-mcp-runtime-npm
 *     <package>[@<version>] [args...]
 *
 * The `entry.command` field is ignored for npm sources — the entry
 * point is fixed to `npx -y` to keep the runtime image's contract
 * predictable. Users who need a custom entrypoint should pick the
 * `docker-mcp-registry` source with their own image.
 */
function dockerArgsForEntry(entry: McpEntry, config: NpmFactoryConfig): string[] {
    if (entry.package === undefined) {
        throw new Error(`MCP "${entry.id}": npm source requires a "package" field.`);
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

    for (const a of entry.args) {
        args.push(a);
    }

    return args;
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
