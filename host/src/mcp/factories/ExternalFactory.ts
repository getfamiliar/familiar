import { ExternalMcpServer } from "../ExternalMcpServer.js";
import type { McpEntry } from "../McpEntry.js";
import type { McpServer } from "../McpServer.js";
import type { McpServerFactory } from "../McpServerFactory.js";

/**
 * Factory for `source: external`. The MCP runs somewhere outside our
 * docker network and is reached over HTTP — no container is started.
 *
 * The factory itself is implemented (it returns a real
 * {@link ExternalMcpServer}), but the surrounding wiring is not:
 * nothing in the agent yet knows how to dial an MCP, with or without
 * the reverse proxy injecting auth. The instance produced here is
 * inert until that wiring lands.
 */
export class ExternalFactory implements McpServerFactory {
    create(entry: McpEntry): McpServer {
        return new ExternalMcpServer(entry);
    }
}
