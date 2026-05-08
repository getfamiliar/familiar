import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { PassThrough, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
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
    /**
     * When true, dump the raw request and response bodies of every
     * `/llm/<provider>/v1/*` call to per-request files under
     * {@link captureDir}. Off by default; controlled by
     * `inference.captureBodies` in `config.yml`. The capture is purely
     * a tap — the forwarded bytes are unchanged and SSE keeps streaming.
     */
    readonly captureBodies?: boolean;
    /**
     * Directory under which capture files are written when
     * {@link captureBodies} is true. Created on demand. Files are
     * named `<isoTs>-<reqId>.req.log` / `.resp.log`.
     */
    readonly captureDir?: string;
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
    private captureDirEnsured = false;

    constructor(config: ReverseProxyConfig) {
        this.config = config;
    }

    async start(bastion: Bastion): Promise<void> {
        bastion.registerPrefix("/llm/", (req, res, restPath) => {
            this.handle(req, res, restPath);
        });
        const ids = Object.keys(this.config.providers);
        const captureSuffix =
            this.config.captureBodies === true
                ? ` (body capture ON → ${this.config.captureDir ?? "<unset>"})`
                : "";
        this.config.log.info(
            ids.length === 0
                ? `reverse-proxy registered /llm/ for no providers${captureSuffix}`
                : `reverse-proxy registered /llm/ for ${ids.length} provider${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}${captureSuffix}`,
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
        this.forward(req, res, providerId, provider, upstreamPath);
    }

    /**
     * Forward a single request to the provider's upstream with auth
     * injection, streaming the response (and request body) so SSE and
     * large uploads pass through untouched.
     */
    private forward(
        req: IncomingMessage,
        res: ServerResponse,
        providerId: string,
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

        const capture = this.openCapture(providerId, req.method ?? "GET", upstreamPath, headers);

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
                if (capture !== undefined) {
                    writeResponseHeader(capture.respFile, upstreamRes);
                    // Tap raw bytes from upstream → respTap → client.
                    // The capture file gets decompressed bytes when
                    // the response is gzip/deflate/br-encoded so the
                    // dump is human-readable; the *forwarded* stream
                    // to the client stays the original compressed
                    // bytes (the SDK sets Accept-Encoding and decodes
                    // it at the client side).
                    const respTap = new PassThrough();
                    const decompressor = pickDecompressor(
                        upstreamRes.headers["content-encoding"],
                        this.config.log,
                        capture.reqId,
                    );
                    if (decompressor !== null) {
                        decompressor.on("data", (chunk: Buffer) => {
                            capture.respFile.write(chunk);
                        });
                        decompressor.on("end", () => {
                            capture.respFile.end();
                        });
                        decompressor.on("error", (err) => {
                            this.config.log.error(
                                `llm proxy capture ${capture.reqId} decompress error: ${err.message}`,
                            );
                            capture.respFile.write(`\n[decompress error: ${err.message}]\n`);
                            capture.respFile.end();
                        });
                        respTap.on("data", (chunk: Buffer) => {
                            decompressor.write(chunk);
                        });
                        respTap.on("end", () => {
                            decompressor.end();
                        });
                        respTap.on("close", () => {
                            decompressor.end();
                        });
                    } else {
                        respTap.on("data", (chunk: Buffer) => {
                            capture.respFile.write(chunk);
                        });
                        const closeRespFile = (): void => {
                            capture.respFile.end();
                        };
                        respTap.on("end", closeRespFile);
                        respTap.on("close", closeRespFile);
                    }
                    respTap.on("error", (err) => {
                        this.config.log.error(
                            `llm proxy capture ${capture.reqId} response tap error: ${err.message}`,
                        );
                        capture.respFile.end();
                    });
                    upstreamRes.pipe(respTap).pipe(res);
                } else {
                    upstreamRes.pipe(res);
                }
                this.config.log.debug(
                    {
                        method: req.method,
                        path: upstreamPath,
                        upstream: upstreamHost,
                        status: upstreamRes.statusCode,
                        captureId: capture?.reqId,
                    },
                    "llm proxy forward",
                );
            },
        );

        upstream.on("error", (err) => {
            this.config.log.error(`llm proxy upstream error from ${upstreamHost}: ${err.message}`);
            if (capture !== undefined) {
                capture.respFile.write(`\n[upstream error: ${err.message}]\n`);
                capture.respFile.end();
            }
            if (!res.headersSent) {
                res.writeHead(502, { "content-type": "text/plain" });
            }
            res.end(`upstream error: ${err.message}`);
        });

        req.on("aborted", () => {
            upstream.destroy();
        });

        if (capture !== undefined) {
            const reqTap = new PassThrough();
            reqTap.on("data", (chunk: Buffer) => {
                capture.reqFile.write(chunk);
            });
            const closeReqFile = (): void => {
                capture.reqFile.end();
            };
            reqTap.on("end", closeReqFile);
            reqTap.on("close", closeReqFile);
            reqTap.on("error", (err) => {
                this.config.log.error(
                    `llm proxy capture ${capture.reqId} request tap error: ${err.message}`,
                );
                closeReqFile();
            });
            req.pipe(reqTap).pipe(upstream);
        } else {
            req.pipe(upstream);
        }
    }

    /**
     * If body capture is enabled, open a pair of write streams under
     * {@link ReverseProxyConfig.captureDir} and return handles for the
     * forward path to tee into. Returns `undefined` when capture is
     * off so the hot path stays a plain `req.pipe(upstream)` with no
     * extra stream layer.
     */
    private openCapture(
        providerId: string,
        method: string,
        upstreamPath: string,
        forwardedHeaders: Readonly<Record<string, string | string[]>>,
    ): CaptureHandles | undefined {
        if (this.config.captureBodies !== true) {
            return undefined;
        }
        const dir = this.config.captureDir;
        if (dir === undefined || dir.length === 0) {
            this.config.log.warn(
                "llm proxy: captureBodies is true but captureDir is unset — capture skipped",
            );
            return undefined;
        }
        if (!this.captureDirEnsured) {
            try {
                mkdirSync(dir, { recursive: true });
                this.captureDirEnsured = true;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.config.log.error(`llm proxy: cannot create capture dir ${dir}: ${msg}`);
                return undefined;
            }
        }
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const reqId = `${ts}-${randomUUID().slice(0, 8)}`;
        const reqPath = join(dir, `${reqId}.req.log`);
        const respPath = join(dir, `${reqId}.resp.log`);
        const reqFile = createWriteStream(reqPath, { flags: "w" });
        const respFile = createWriteStream(respPath, { flags: "w" });
        // Do NOT echo the Authorization header into the dump — even
        // though the proxy is the holder of the real upstream key, a
        // capture file lying around with a live bearer token in it is
        // a footgun. The forwarded headers are otherwise inert.
        const safeHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(forwardedHeaders)) {
            if (k.toLowerCase() === "authorization") {
                safeHeaders[k] = "[redacted]";
                continue;
            }
            safeHeaders[k] = v;
        }
        reqFile.write(
            `# ${method} ${upstreamPath} → ${providerId}\n# headers: ${JSON.stringify(safeHeaders)}\n# body:\n`,
        );
        this.config.log.info(`llm proxy capture ${reqId} → ${reqPath} / ${respPath}`);
        return { reqId, reqFile, respFile };
    }
}

/** Per-request capture handles passed between forward() helpers. */
interface CaptureHandles {
    readonly reqId: string;
    readonly reqFile: WriteStream;
    readonly respFile: WriteStream;
}

/**
 * Build a decompressor for the upstream's `content-encoding` so the
 * captured body is human-readable instead of opaque gzip bytes.
 * Returns `null` when the response is unencoded or the encoding is
 * unknown (in which case the raw bytes are written and the operator
 * can decode out-of-band). The forwarded bytes to the client are
 * untouched either way — only the capture file is decompressed.
 */
function pickDecompressor(
    encodingHeader: string | string[] | undefined,
    log: Logger,
    reqId: string,
): Transform | null {
    if (encodingHeader === undefined) {
        return null;
    }
    const raw = Array.isArray(encodingHeader) ? encodingHeader.join(",") : encodingHeader;
    const encoding = raw.toLowerCase().trim();
    if (encoding === "" || encoding === "identity") {
        return null;
    }
    // Multi-encodings (`gzip, br`) are rare from inference upstreams;
    // refuse rather than guess at chained decoders. The capture stays
    // raw so the operator can investigate manually.
    if (encoding.includes(",")) {
        log.warn(
            `llm proxy capture ${reqId}: chained content-encoding "${encoding}" — writing raw bytes to capture`,
        );
        return null;
    }
    if (encoding === "gzip" || encoding === "x-gzip") {
        return createGunzip();
    }
    if (encoding === "deflate") {
        return createInflate();
    }
    if (encoding === "br") {
        return createBrotliDecompress();
    }
    log.warn(
        `llm proxy capture ${reqId}: unknown content-encoding "${encoding}" — writing raw bytes to capture`,
    );
    return null;
}

/**
 * Write a small status header to the response capture file before the
 * body bytes start arriving. Mirrors the request-side header so each
 * dump file is self-describing without needing to look up its sibling.
 */
function writeResponseHeader(file: WriteStream, upstreamRes: IncomingMessage): void {
    file.write(
        `# status: ${upstreamRes.statusCode ?? "?"}\n# headers: ${JSON.stringify(upstreamRes.headers)}\n# body:\n`,
    );
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
