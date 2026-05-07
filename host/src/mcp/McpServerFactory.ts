import type { McpEntry } from "./McpEntry.js";
import type { McpTransport } from "./transports/McpTransport.js";

/**
 * Builds an {@link McpTransport} for a single validated `McpEntry`.
 * One implementation per `source` value; the `McpGateway` picks the
 * right one by `entry.source`.
 *
 * Kept as a flat interface — `create()` is the only surface, and
 * shared lifecycle code lives on the transport classes themselves
 * (per the existing "one concrete base class" rule).
 */
export interface McpServerFactory {
    /**
     * Build a transport from the entry. Throws synchronously if the
     * entry lacks fields the source needs — the linter catches these
     * earlier; this is a safety net.
     */
    create(entry: McpEntry): McpTransport;
}
