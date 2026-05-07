import type { Logger } from "effective-assistant-shared";
import type { McpEntry } from "../McpEntry.js";
import type { McpServerFactory } from "../McpServerFactory.js";
import { HttpMcpTransport } from "../transports/HttpMcpTransport.js";
import type { McpTransport } from "../transports/McpTransport.js";

/**
 * Factory for `source: external`. Produces an {@link HttpMcpTransport}
 * pointing at the entry's `url`. The transport is real and works
 * today, but nothing in the agent yet dials `${BASTION_URL}/mcp/<id>`,
 * so external MCPs are reachable through the gateway but not yet
 * consumed by handlers.
 */
export class ExternalFactory implements McpServerFactory {
    private readonly log: Logger;

    constructor(log: Logger) {
        this.log = log;
    }

    create(entry: McpEntry): McpTransport {
        if (entry.url === undefined) {
            throw new Error(`MCP "${entry.id}": external source requires a "url" field.`);
        }
        return new HttpMcpTransport({
            id: entry.id,
            title: entry.title,
            description: entry.description,
            upstreamUrl: entry.url,
            log: this.log.child({ mcp: entry.id }),
        });
    }
}
