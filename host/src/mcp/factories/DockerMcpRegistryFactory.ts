import type { Logger } from "effective-assistant-shared";
import { SHARED_NETWORK_NAME } from "../../DockerTools.js";
import type { McpEntry } from "../McpEntry.js";
import type { McpServerFactory } from "../McpServerFactory.js";
import type { McpTransport } from "../transports/McpTransport.js";
import { StdioMcpTransport } from "../transports/StdioMcpTransport.js";

/**
 * Build the `docker run` argv vector for a foreground stdio MCP child.
 *
 * Layout:
 *   run -i --rm --name ea-mcp-<id> --network <net>
 *     [--entrypoint <command>]
 *     [-e KEY=VAL ...]
 *     [-v HOST:CONTAINER[:ro] ...]
 *     <image> [args...]
 *
 * `-i` keeps stdin attached so the MCP can read JSON-RPC frames; no
 * `-d` (this is a foreground child of the bastion); `--rm` reaps the
 * container when the process exits.
 */
function dockerArgsForEntry(entry: McpEntry): string[] {
    if (entry.image === undefined) {
        throw new Error(`MCP "${entry.id}": docker-mcp-registry source requires an "image" field.`);
    }
    const args: string[] = ["run", "-i", "--rm", "--name", `ea-mcp-${entry.id}`];

    if (entry.network.disable) {
        args.push("--network", "none");
    } else {
        args.push("--network", SHARED_NETWORK_NAME);
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

    for (const a of entry.args) {
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
    private readonly log: Logger;

    constructor(log: Logger) {
        this.log = log;
    }

    create(entry: McpEntry): McpTransport {
        return new StdioMcpTransport({
            id: entry.id,
            title: entry.title,
            description: entry.description,
            dockerArgs: dockerArgsForEntry(entry),
            idleTimeoutSeconds: entry.idleTimeoutSeconds,
            log: this.log.child({ mcp: entry.id }),
        });
    }
}
