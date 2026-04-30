import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { request as httpsRequest } from "node:https";

const UPSTREAM_HOST = "api.anthropic.com";
const UPSTREAM_PORT = 443;

/**
 * Forwards a single client request to api.anthropic.com, replacing
 * `x-api-key` with the proxy's configured key, and pipes the upstream
 * response back to the client. Streaming-safe (SSE).
 *
 * @param apiKey - The Anthropic API key to inject.
 * @param clientReq - The incoming request from an agent container.
 * @param clientRes - The response stream to write back to.
 */
function handleRequest(
    apiKey: string,
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
): void {
    const headers = {
        ...clientReq.headers,
        host: UPSTREAM_HOST,
        "x-api-key": apiKey,
    };
    delete headers.authorization;

    const upstream = httpsRequest(
        {
            host: UPSTREAM_HOST,
            port: UPSTREAM_PORT,
            method: clientReq.method,
            path: clientReq.url,
            headers,
        },
        (upstreamRes) => {
            clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(clientRes);
        },
    );

    upstream.on("error", (err) => {
        console.error(`upstream error: ${err.message}`);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { "content-type": "text/plain" });
        }
        clientRes.end(`upstream error: ${err.message}`);
    });

    clientReq.on("error", (err) => {
        console.error(`client error: ${err.message}`);
        upstream.destroy(err);
    });

    clientReq.pipe(upstream);
}

/**
 * Reads ANTHROPIC_API_KEY from env and starts the proxy server. Exits
 * non-zero if the key is missing.
 */
function main(): void {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        console.error("ANTHROPIC_API_KEY env var is required");
        process.exit(1);
    }
    const port = Number.parseInt(process.env.PORT ?? "8788", 10);

    const server = createServer((req, res) => {
        handleRequest(apiKey, req, res);
    });

    server.listen(port, () => {
        console.log(`anthropic-proxy listening on :${port}`);
    });
}

main();
