import type { McpEntry } from "../McpEntry.js";
import type { McpServerFactory } from "../McpServerFactory.js";
import type { McpTransport } from "../transports/McpTransport.js";

/**
 * Factory stub for `source: pypi`. The intended behaviour is to run
 * the package inside a generic python container (likely a
 * `StdioMcpTransport` with a synthesized `docker run -i python-base
 * uvx <package>` argv). Not implemented yet — throws at gateway
 * start-time so a user who declares a pypi MCP today gets a clear
 * failure instead of a half-running transport.
 */
export class PypiFactory implements McpServerFactory {
    create(entry: McpEntry): McpTransport {
        throw new Error(
            `MCP "${entry.id}": pypi source not implemented yet. Use docker-mcp-registry for now.`,
        );
    }
}
