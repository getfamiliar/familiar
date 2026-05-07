import type { McpEntry } from "../McpEntry.js";
import { McpServer } from "../McpServer.js";
import type { McpServerFactory } from "../McpServerFactory.js";

/**
 * `McpServer` subclass that runs an image pulled from the Docker MCP
 * registry. The image reference is the registry's `image` field
 * (e.g. `mcp/fetch`), copied verbatim into `mcp.yml` for now; a
 * future CLI helper will fetch and translate the registry's
 * `server.yaml` automatically.
 */
class DockerRegistryMcpServer extends McpServer {
    private readonly imageRef: string;

    constructor(entry: McpEntry) {
        super(entry);
        if (entry.image === undefined) {
            throw new Error(
                `MCP "${entry.id}": docker-mcp-registry source requires an "image" field.`,
            );
        }
        this.imageRef = entry.image;
    }

    protected override get image(): string {
        return this.imageRef;
    }
}

/**
 * Factory for `source: docker-mcp-registry`. Each entry produces a
 * {@link DockerRegistryMcpServer}. No registry-side lookup happens
 * here — `mcp.yml` is the source of truth at runtime; the registry
 * URL is only consulted by the (future) "add MCP" CLI helper.
 */
export class DockerMcpRegistryFactory implements McpServerFactory {
    create(entry: McpEntry): McpServer {
        return new DockerRegistryMcpServer(entry);
    }
}
