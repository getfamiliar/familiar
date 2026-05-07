import type { McpEntry } from "../McpEntry.js";
import type { McpServer } from "../McpServer.js";
import type { McpServerFactory } from "../McpServerFactory.js";

/**
 * Factory stub for `source: pypi`. The intended behaviour is to run
 * the package inside a generic python container with the pypi
 * package installed at start. Not implemented yet — throws so a user
 * who declares a pypi MCP today gets a clear, immediate failure at
 * boot rather than a half-running container.
 */
export class PypiFactory implements McpServerFactory {
    create(entry: McpEntry): McpServer {
        throw new Error(
            `MCP "${entry.id}": pypi source not implemented yet. Use docker-mcp-registry for now.`,
        );
    }
}
