import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Common interface every MCP transport implements so the
 * {@link McpGateway} can dispatch without branching on source. Concrete
 * implementations live alongside this file:
 *
 * - {@link StdioMcpTransport} — `docker run -i` child, JSON-RPC over stdio.
 * - {@link HttpMcpTransport}  — forward HTTP request to an upstream URL.
 *
 * The dispatch shape is identical for all transports (an HTTP request
 * comes in, an HTTP response goes out); only what's behind the wall
 * differs. The gateway never touches the docker CLI or HTTP forwarder
 * directly — it just calls `handle()`.
 */
export interface McpTransport {
    /** Stable id from `mcp.yml`, used for logging and (de)duplication. */
    readonly id: string;
    /** Short human-facing title from `mcp.yml`, surfaced in the catalog. */
    readonly title: string;
    /** Longer human-facing description from `mcp.yml`, surfaced in the catalog. */
    readonly description: string;
    /**
     * Handle one inbound request whose path matched the gateway's
     * `/mcp/<id>/` prefix. `restPath` is the part after `/<id>` (still
     * leading-slashed). Implementations send a complete response on
     * `res` before resolving.
     */
    handle(req: IncomingMessage, res: ServerResponse, restPath: string): Promise<void>;
    /** Release any held resources (child processes, timers, sockets). */
    stop(): Promise<void>;
}
