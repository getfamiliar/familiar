import type { Logger } from "effective-assistant-shared";
import { SHARED_NETWORK_NAME } from "../../DockerTools.js";
import { createMcpFileSink, type McpFileSink } from "../../tools/LogRetentionTools.js";
import type { McpEntry } from "../McpEntry.js";
import type { McpServerFactory } from "../McpServerFactory.js";
import type { McpTransport } from "../transports/McpTransport.js";
import { StdioMcpTransport } from "../transports/StdioMcpTransport.js";
import type { DockerArgsOptions } from "./DockerArgsOptions.js";

/** Configuration for {@link DockerMcpRegistryFactory}. */
export interface DockerMcpRegistryFactoryConfig {
    /** Logger used by transports for spawn/exit/error events. */
    readonly log: Logger;
    /** Per-MCP log directory; one rotated file is opened per id on first spawn. */
    readonly mcpLogsDir: string;
    /** Days of rotated log retention. */
    readonly logRetentionDays: number;
}

/**
 * Build the `docker run` argv vector for a foreground stdio MCP child.
 *
 * Default layout (no `options` passed):
 *   run -i --rm --name ea-mcp-<id> --network <net>
 *     [--entrypoint <command>]
 *     [-e KEY=VAL ...]
 *     [-v HOST:CONTAINER[:ro] ...]
 *     <image> [entry.args...]
 *
 * `-i` keeps stdin attached so the MCP can read JSON-RPC frames; no
 * `-d` (this is a foreground child of the bastion); `--rm` reaps the
 * container when the process exits.
 *
 * `options` mirrors {@link buildNpmDockerArgs} — `interactive: true`
 * adds `-t`, `containerName: null` drops `--name`, and `appendArgs`
 * is concatenated AFTER `entry.args` (used by `./cli.sh mcp call`,
 * which never replaces the mcp.yml args block).
 */
export function buildDockerRegistryArgs(
    entry: McpEntry,
    options: DockerArgsOptions = {},
): string[] {
    if (entry.image === undefined) {
        throw new Error(`MCP "${entry.id}": docker-mcp-registry source requires an "image" field.`);
    }
    const containerName =
        options.containerName === undefined ? `ea-mcp-${entry.id}` : options.containerName;
    const interactive = options.interactive ?? false;

    const args: string[] = ["run", interactive ? "-it" : "-i", "--rm"];
    if (containerName !== null) {
        args.push("--name", containerName);
    }

    if (entry.network.disable) {
        args.push("--network", "none");
    } else {
        args.push("--network", SHARED_NETWORK_NAME);
        // See the matching comment in NpmFactory: `ea-net` is
        // IPv4-only but docker's embedded DNS still returns AAAA
        // records for dual-stack hosts. Disabling IPv6 in-kernel
        // makes `getaddrinfo` filter them out so apps don't waste
        // time on connect attempts that always ENETUNREACH.
        args.push("--sysctl", "net.ipv6.conf.all.disable_ipv6=1");
    }

    if (entry.command !== null) {
        args.push("--entrypoint", entry.command);
    }

    for (const env of entry.env) {
        args.push("-e", `${env.name}=${env.value}`);
    }
    for (const volume of entry.volumes) {
        args.push("-v", volume);
    }

    args.push(entry.image);

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
 * Factory for `source: docker-mcp-registry`. Produces an
 * {@link StdioMcpTransport} configured with a foreground `docker run -i`
 * argv vector synthesized from the entry. The image is pulled lazily
 * by docker on first spawn.
 */
export class DockerMcpRegistryFactory implements McpServerFactory {
    private readonly config: DockerMcpRegistryFactoryConfig;

    constructor(config: DockerMcpRegistryFactoryConfig) {
        this.config = config;
    }

    create(entry: McpEntry): McpTransport {
        const { mcpLogsDir, logRetentionDays } = this.config;
        const openFileSink = (): Promise<McpFileSink> =>
            createMcpFileSink(mcpLogsDir, entry.id, logRetentionDays);
        return new StdioMcpTransport({
            id: entry.id,
            title: entry.title,
            description: entry.description,
            dockerArgs: buildDockerRegistryArgs(entry),
            idleTimeoutSeconds: entry.idleTimeoutSeconds,
            log: this.config.log.child({ mcp: entry.id }),
            openFileSink,
        });
    }
}
