import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Logger } from "effective-assistant-shared";
import type { Bastion, BastionModule } from "./Bastion.js";

/**
 * Default upstream base URLs per known provider. Looked up by provider
 * id. Users can override via `inference.baseUrls.<provider>` in
 * config.yml (e.g. for self-hosted gateways or non-standard regional
 * endpoints).
 */
const KNOWN_PROVIDER_BASE_URLS: Readonly<Record<string, string>> = {
    featherless: "https://api.featherless.ai",
    groq: "https://api.groq.com/openai",
    openai: "https://api.openai.com",
    anthropic: "https://api.anthropic.com",
    deepseek: "https://api.deepseek.com",
};

/** Per-provider runtime config built from `config.yml`. */
export interface ProviderConfig {
    /** Upstream base URL, no trailing slash. */
    readonly upstreamBase: string;
    /** Real API key forwarded as `Authorization: Bearer <key>`. */
    readonly upstreamApiKey: string;
}

/** Configuration for the {@link ReverseProxy} module. */
export interface ReverseProxyConfig {
    /** Provider id → upstream + key. Built by `Start.ts` from config. */
    readonly providers: Readonly<Record<string, ProviderConfig>>;
    /** Logger used for forward / error lines. */
    readonly log: Logger;
}

/**
 * Headers stripped from inbound requests before forwarding. Inbound
 * `authorization` must never leak to the upstream — this proxy is the
 * *only* component that holds the real API key. Hop-by-hop headers
 * are dropped so node sets them itself for the outbound request.
 */
const HEADERS_TO_STRIP = new Set([
    "authorization",
    "x-api-key",
    "host",
    "connection",
    "content-length",
]);

/**
 * Bastion module that handles `/llm/<provider>/v1/*`. Forwards each
 * request to the matching provider's upstream with the right
 * `Authorization` header injected. Streams the response body unchanged
 * so SSE works for streaming completions.
 *
 * Multiple providers run concurrently — handler A may pick
 * `/llm/featherless/v1`, handler B `/llm/groq/v1`. The proxy picks the
 * upstream and key by parsing the path's first segment after `/llm/`.
 */
export class ReverseProxy implements BastionModule {
    readonly name = "reverse-proxy";

    private readonly config: ReverseProxyConfig;

    constructor(config: ReverseProxyConfig) {
        this.config = config;
    }

    async start(bastion: Bastion): Promise<void> {
        bastion.registerPrefix("/llm/", (req, res, restPath) => {
            this.handle(req, res, restPath);
        });
        const ids = Object.keys(this.config.providers);
        this.config.log.info(
            ids.length === 0
                ? "reverse-proxy registered /llm/ for no providers"
                : `reverse-proxy registered /llm/ for ${ids.length} provider${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`,
        );
    }

    async stop(): Promise<void> {
        // Nothing per-module: the bastion's HttpServer owns the socket.
    }

    /**
     * Parse `<provider>/v1/<rest>` from `restPath`, look up the
     * provider, and forward the request. Replies 404 for unknown
     * providers, 400 for malformed paths.
     */
    private handle(req: IncomingMessage, res: ServerResponse, restPath: string): void {
        // restPath always starts with `/`. Strip it, split off the first segment.
        const trimmed = restPath.startsWith("/") ? restPath.slice(1) : restPath;
        const slashIdx = trimmed.indexOf("/");
        if (slashIdx <= 0) {
            replyError(res, 400, "expected /llm/<provider>/<rest>");
            return;
        }
        const providerId = trimmed.slice(0, slashIdx);
        const upstreamPath = trimmed.slice(slashIdx); // includes leading `/`
        const provider = this.config.providers[providerId];
        if (provider === undefined) {
            replyError(res, 404, `unknown provider "${providerId}"`);
            return;
        }
        this.forward(req, res, provider, upstreamPath);
    }

    /**
     * Forward a single request to the provider's upstream with auth
     * injection, streaming the response (and request body) so SSE and
     * large uploads pass through untouched.
     */
    private forward(
        req: IncomingMessage,
        res: ServerResponse,
        provider: ProviderConfig,
        upstreamPath: string,
    ): void {
        const url = new URL(provider.upstreamBase);
        if (url.protocol !== "https:") {
            replyError(res, 500, `provider upstream must be https, got ${url.protocol}`);
            return;
        }
        const upstreamHost = url.hostname;
        const upstreamPort = url.port ? Number(url.port) : 443;
        const baseTrailing = url.pathname.replace(/\/$/, "");
        const path = `${baseTrailing}${upstreamPath}`;

        const headers = sanitizeHeaders(req.headers);
        headers.authorization = `Bearer ${provider.upstreamApiKey}`;
        headers.host = upstreamHost;

        const upstream = httpsRequest(
            {
                method: req.method,
                hostname: upstreamHost,
                port: upstreamPort,
                path,
                headers,
            },
            (upstreamRes) => {
                res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
                upstreamRes.pipe(res);
                this.config.log.debug(
                    {
                        method: req.method,
                        path: upstreamPath,
                        upstream: upstreamHost,
                        status: upstreamRes.statusCode,
                    },
                    "llm proxy forward",
                );
            },
        );

        upstream.on("error", (err) => {
            this.config.log.error(`llm proxy upstream error from ${upstreamHost}: ${err.message}`);
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
 * Build the providers map from a parsed `inference.apiKeys` mapping
 * and an optional `inference.baseUrls` override mapping. Unknown
 * providers (no baked-in default and no override) fail loudly so the
 * daemon doesn't silently drop a configured key.
 */
export function buildProviders(
    apiKeys: Readonly<Record<string, unknown>>,
    baseUrlOverrides: Readonly<Record<string, unknown>>,
): Readonly<Record<string, ProviderConfig>> {
    const providers: Record<string, ProviderConfig> = {};
    for (const [id, key] of Object.entries(apiKeys)) {
        if (typeof key !== "string" || key.length === 0) {
            throw new Error(`inference.apiKeys.${id}: must be a non-empty string`);
        }
        const override = baseUrlOverrides[id];
        const baseUrl =
            typeof override === "string" && override.length > 0
                ? override
                : KNOWN_PROVIDER_BASE_URLS[id];
        if (baseUrl === undefined) {
            throw new Error(
                `inference.apiKeys.${id} is set but ${id} is not a known provider — set inference.baseUrls.${id} to its upstream URL.`,
            );
        }
        providers[id] = { upstreamBase: baseUrl, upstreamApiKey: key };
    }
    return providers;
}

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

/** Send a plain-text error response with the given status. */
function replyError(res: ServerResponse, status: number, message: string): void {
    if (!res.headersSent) {
        res.writeHead(status, { "content-type": "text/plain" });
    }
    res.end(message);
}
