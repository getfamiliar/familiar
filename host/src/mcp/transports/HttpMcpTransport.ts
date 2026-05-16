import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Logger } from "@getfamiliar/shared";
import type { McpTransport } from "./McpTransport.js";

/** Configuration for an `HttpMcpTransport`. */
export interface HttpMcpTransportConfig {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    /** Upstream MCP base URL, no trailing slash. */
    readonly upstreamUrl: string;
    /**
     * Optional `Authorization` value (e.g. `Bearer ghp_...`) to inject
     * on every forwarded request. Kept on the host so the agent never
     * sees the credential.
     */
    readonly authorization?: string;
    /** Logger for forward / error lines. */
    readonly log: Logger;
}

/**
 * MCP transport that forwards HTTP requests to a remote (or
 * container-hosted) MCP server. Used for `source: external` today;
 * future container-hosted Streamable HTTP MCPs will use it too.
 *
 * Streams request and response bodies so SSE and chunked replies pass
 * through unchanged.
 */
export class HttpMcpTransport implements McpTransport {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    private readonly upstreamUrl: URL;
    private readonly authorization: string | undefined;
    private readonly log: Logger;

    constructor(config: HttpMcpTransportConfig) {
        this.id = config.id;
        this.title = config.title;
        this.description = config.description;
        this.upstreamUrl = new URL(config.upstreamUrl);
        this.authorization = config.authorization;
        this.log = config.log;
    }

    async handle(req: IncomingMessage, res: ServerResponse, restPath: string): Promise<void> {
        const baseTrailing = this.upstreamUrl.pathname.replace(/\/$/, "");
        const path = `${baseTrailing}${restPath}`;
        const isHttps = this.upstreamUrl.protocol === "https:";
        const port = this.upstreamUrl.port ? Number(this.upstreamUrl.port) : isHttps ? 443 : 80;

        const headers = sanitizeHeaders(req.headers);
        if (this.authorization !== undefined) {
            headers.authorization = this.authorization;
        }
        headers.host = this.upstreamUrl.hostname;

        const send = isHttps ? httpsRequest : httpRequest;
        const upstream = send(
            {
                method: req.method,
                hostname: this.upstreamUrl.hostname,
                port,
                path,
                headers,
            },
            (upstreamRes) => {
                res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
                upstreamRes.pipe(res);
                this.log.debug(
                    {
                        mcp: this.id,
                        method: req.method,
                        path: restPath,
                        status: upstreamRes.statusCode,
                    },
                    "http mcp forward",
                );
            },
        );

        upstream.on("error", (err) => {
            this.log.error(`http mcp '${this.id}' upstream error: ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(502, { "content-type": "text/plain" });
            }
            res.end(`upstream error: ${err.message}`);
        });

        req.on("aborted", () => {
            upstream.destroy();
        });

        req.pipe(upstream);
    }

    async stop(): Promise<void> {
        // Stateless forwarder; nothing to release.
    }
}

const HEADERS_TO_STRIP = new Set([
    "authorization",
    "x-api-key",
    "host",
    "connection",
    "content-length",
]);

/** Copy non-stripped inbound headers, lower-casing names. */
function sanitizeHeaders(input: NodeJS.Dict<string | string[]>): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(input)) {
        if (value === undefined) {
            continue;
        }
        const lower = name.toLowerCase();
        if (HEADERS_TO_STRIP.has(lower)) {
            continue;
        }
        out[lower] = value;
    }
    return out;
}
