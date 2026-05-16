import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "@getfamiliar/shared";

/**
 * Handler for a request whose URL path matched a registered prefix.
 * Receives `restPath`: the portion of the URL path **after** the
 * matching prefix (still leading-slashed, never empty). Modules use
 * this to do further routing without re-parsing the whole URL.
 */
export type PrefixHandler = (
    req: IncomingMessage,
    res: ServerResponse,
    restPath: string,
) => void | Promise<void>;

/** Configuration for the {@link HttpServer}. */
export interface HttpServerConfig {
    /** Address to bind on (e.g. the familiar-net bridge gateway IP). */
    readonly bindHost: string;
    /** Port to listen on. */
    readonly port: number;
    /** Logger used for accept/dispatch/error lines. */
    readonly log: Logger;
}

/**
 * Thin `node:http` wrapper that owns the listening socket and routes
 * requests by **longest matching path prefix** to handlers registered
 * by the bastion's modules. Owns nothing else: it does not know about
 * LLM proxying, MCP gateways, or any specific module's responsibilities.
 *
 * Modules call {@link registerPrefix} during their own `start()` to
 * claim a path prefix (e.g. `/llm/`, `/mcp/`) and a handler. Requests
 * that don't match any registered prefix get a clean 404.
 */
export class HttpServer {
    private readonly config: HttpServerConfig;
    private readonly routes: Array<{ prefix: string; handler: PrefixHandler }> = [];
    private server: Server | null = null;

    constructor(config: HttpServerConfig) {
        this.config = config;
    }

    /**
     * Register a handler for any request whose URL path begins with
     * `prefix`. Prefix must end with a `/` to avoid `/llm` matching
     * `/llmFoo`. Throws if the prefix is already registered.
     */
    registerPrefix(prefix: string, handler: PrefixHandler): void {
        if (!prefix.endsWith("/")) {
            throw new Error(`HttpServer prefix "${prefix}" must end with "/"`);
        }
        for (const route of this.routes) {
            if (route.prefix === prefix) {
                throw new Error(`HttpServer prefix "${prefix}" already registered`);
            }
        }
        this.routes.push({ prefix, handler });
        // Keep routes sorted longest-first so longest-prefix-match is
        // a single linear scan with first-hit-wins.
        this.routes.sort((a, b) => b.prefix.length - a.prefix.length);
    }

    /** Start listening. Resolves once the socket is bound. */
    async start(): Promise<void> {
        if (this.server !== null) {
            return;
        }
        const server = createServer((req, res) => {
            void this.dispatch(req, res);
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(this.config.port, this.config.bindHost, () => {
                server.off("error", reject);
                resolve();
            });
        });
        this.server = server;
        this.config.log.info(
            `bastion server binding on ${this.config.bindHost}:${this.config.port}`,
        );
    }

    /**
     * Stop listening. `server.close` only refuses *new* connections
     * and waits for existing ones to drain on their own — a
     * lingering keep-alive from the agent container could keep us
     * waiting indefinitely. `closeAllConnections()` (Node ≥ 18.2)
     * forcibly destroys those, so the close callback fires
     * promptly. The optional-chaining guards older runtimes.
     */
    async stop(): Promise<void> {
        if (this.server === null) {
            return;
        }
        const server = this.server;
        this.server = null;
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => {
            server.close(() => {
                resolve();
            });
        });
    }

    /** Find the longest registered prefix matching the request path. */
    private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = req.url ?? "/";
        const pathEnd = url.indexOf("?");
        const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
        for (const route of this.routes) {
            if (path.startsWith(route.prefix)) {
                const rest = path.slice(route.prefix.length - 1); // keep leading `/`
                try {
                    await route.handler(req, res, rest === "" ? "/" : rest);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.config.log.error(
                        `bastion handler error on prefix '${route.prefix}': ${message}`,
                    );
                    if (!res.headersSent) {
                        res.writeHead(500, { "content-type": "text/plain" });
                    }
                    res.end("internal error");
                }
                return;
            }
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    }
}
