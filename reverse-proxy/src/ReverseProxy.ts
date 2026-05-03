import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

/** Configuration for a {@link ReverseProxy}. */
export interface ReverseProxyConfig {
    /** Port to listen on (e.g. 8788). */
    readonly listenPort: number;
    /** Upstream base URL, e.g. `https://api.featherless.ai`. No trailing slash. */
    readonly upstreamBase: string;
    /** API key forwarded as `Authorization: Bearer <key>` to the upstream. */
    readonly upstreamApiKey: string;
}

const HEADERS_TO_STRIP = new Set([
    // Inbound auth must never reach the upstream — the proxy is the *only*
    // place that knows the real key.
    "authorization",
    "x-api-key",
    // Hop-by-hop / connection-management headers should not be forwarded
    // verbatim. Node will set its own.
    "host",
    "connection",
    "content-length",
]);

/**
 * Reverse HTTP proxy. Listens on a local port, forwards every request to the
 * configured upstream, and injects `Authorization: Bearer <upstreamApiKey>`
 * before forwarding. Streams the response body back unchanged so SSE works.
 *
 * The proxy is the only component in the system that sees the real API key
 * — clients in the agent container talk to it with a placeholder key and
 * cannot exfiltrate the real one through tool calls or prompt injection.
 */
export class ReverseProxy {
    private readonly config: ReverseProxyConfig;
    private readonly upstreamHost: string;
    private readonly upstreamPort: number;
    private readonly upstreamPathPrefix: string;
    private server: Server | null = null;

    constructor(config: ReverseProxyConfig) {
        this.config = config;
        const url = new URL(config.upstreamBase);
        if (url.protocol !== "https:") {
            throw new Error(`Proxy only supports https upstreams, got ${url.protocol}`);
        }
        this.upstreamHost = url.hostname;
        this.upstreamPort = url.port ? Number(url.port) : 443;
        this.upstreamPathPrefix = url.pathname.replace(/\/$/, "");
    }

    /** Start listening. Resolves when the socket is bound. */
    async start(): Promise<void> {
        const server = createServer((req, res) => {
            this.forward(req, res);
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(this.config.listenPort, "0.0.0.0", () => {
                server.off("error", reject);
                resolve();
            });
        });
        this.server = server;
        console.error(
            `Reverse proxy listening on 0.0.0.0:${this.config.listenPort}, upstream=${this.config.upstreamBase}`,
        );
    }

    /** Stop listening. Resolves when the socket is fully closed. */
    async stop(): Promise<void> {
        if (this.server === null) {
            return;
        }
        const server = this.server;
        this.server = null;
        await new Promise<void>((resolve, reject) => {
            server.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }

    /**
     * Forward a single inbound request to the upstream with auth injection,
     * then stream the response back.
     */
    private forward(req: IncomingMessage, res: ServerResponse): void {
        const path = `${this.upstreamPathPrefix}${req.url ?? "/"}`;
        const headers = sanitizeHeaders(req.headers);
        headers.authorization = `Bearer ${this.config.upstreamApiKey}`;
        headers.host = this.upstreamHost;

        const upstream = httpsRequest(
            {
                method: req.method,
                hostname: this.upstreamHost,
                port: this.upstreamPort,
                path,
                headers,
            },
            (upstreamRes) => {
                res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
                upstreamRes.pipe(res);
                console.error(
                    `[proxy] ${req.method ?? "?"} ${req.url ?? "/"} → ${upstreamRes.statusCode ?? "?"}`,
                );
            },
        );

        upstream.on("error", (err) => {
            console.error(`[proxy] upstream error for ${req.method} ${req.url}: ${err.message}`);
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
}

/**
 * Copy non-stripped inbound headers into a new object suitable for the
 * upstream request. Header names are normalized to lowercase.
 */
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
