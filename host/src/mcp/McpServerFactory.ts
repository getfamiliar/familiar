import type { McpEntry } from "./McpEntry.js";
import type { McpServer } from "./McpServer.js";

/**
 * Factory that turns a validated {@link McpEntry} into a runnable
 * {@link McpServer}. One factory per `source` value; the runner picks
 * the right factory by `entry.source`.
 *
 * Kept as a flat interface (no base class) — `create()` is the only
 * surface and there is nothing meaningful to share between factories.
 * Shared lifecycle code lives on {@link McpServer} itself.
 */
export interface McpServerFactory {
    /**
     * Build an `McpServer` from a validated entry. Throws synchronously
     * if the entry is missing source-specific fields the factory needs
     * (the linter catches these earlier; this is a safety net).
     */
    create(entry: McpEntry): McpServer;
}
