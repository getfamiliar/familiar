import type { McpEntry } from "../McpEntry.js";
import type { McpServer } from "../McpServer.js";
import type { McpServerFactory } from "../McpServerFactory.js";

/**
 * Factory stub for `source: npm`. The intended behaviour is to run
 * the package inside a generic node container with the npm package
 * installed at start. Not implemented yet — throws so a user who
 * declares an npm MCP today gets a clear, immediate failure at boot
 * rather than a half-running container.
 */
export class NpmFactory implements McpServerFactory {
    create(entry: McpEntry): McpServer {
        throw new Error(
            `MCP "${entry.id}": npm source not implemented yet. Use docker-mcp-registry for now.`,
        );
    }
}
