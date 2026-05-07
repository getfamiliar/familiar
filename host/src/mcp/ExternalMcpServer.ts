import type { McpEntry } from "./McpEntry.js";
import { McpServer } from "./McpServer.js";

/**
 * MCP reachable as a remote HTTP endpoint — there is no container to
 * start. `start()` and `stop()` are no-ops; the URL is exposed so the
 * agent's (future) tool layer can dial it directly through the
 * reverse proxy when MCP wiring lands.
 *
 * Inherits from `McpServer` to keep one base class for the runner to
 * iterate over. The "wasted" docker plumbing in the base is the
 * deliberate cost of avoiding a separate interface + abstract layer.
 */
export class ExternalMcpServer extends McpServer {
    /** Remote endpoint URL (HTTP/SSE). Required by `external` source. */
    readonly url: string;

    constructor(entry: McpEntry) {
        super(entry);
        if (entry.url === undefined) {
            throw new Error(`MCP "${entry.id}": external source requires a "url" field.`);
        }
        this.url = entry.url;
    }

    override async start(): Promise<void> {
        // No container to manage; the endpoint is remote.
    }

    override async stop(): Promise<void> {
        // No container to manage; the endpoint is remote.
    }
}
