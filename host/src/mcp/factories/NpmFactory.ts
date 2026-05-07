import type { McpEntry } from "../McpEntry.js";
import type { McpServerFactory } from "../McpServerFactory.js";
import type { McpTransport } from "../transports/McpTransport.js";

/**
 * Factory stub for `source: npm`. The intended behaviour is to run
 * the package inside a generic node container (likely a
 * `StdioMcpTransport` with a synthesized `docker run -i node-base
 * npx <package>` argv). Not implemented yet — throws at gateway
 * start-time so a user who declares an npm MCP today gets a clear
 * failure instead of a half-running transport.
 */
export class NpmFactory implements McpServerFactory {
    create(entry: McpEntry): McpTransport {
        throw new Error(
            `MCP "${entry.id}": npm source not implemented yet. Use docker-mcp-registry for now.`,
        );
    }
}
