import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { PassThrough, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Logger } from "@getfamiliar/shared";
import type { ResolvedProvider } from "../models/ProviderResolution.js";
import type { Bastion, BastionModule } from "./Bastion.js";
import { NPM_PROVIDER_PROFILES, resolveUpstreamBase } from "./NpmProviderProfiles.js";

/** Per-provider runtime config built from `config.yml`. */
export interface ProviderConfig {
    /** Upstream base URL, no trailing slash. */
    readonly upstreamBase: string;
    /**
     * Inject the real API key into the outbound headers using the
     * provider's preferred header name (Bearer for most, `x-api-key`
     * for Anthropic, `x-goog-api-key` for Google, …). The proxy calls
     * this after stripping inbound auth headers from the agent.
     */
    readonly applyAuth: (headers: Record<string, string | string[]>) => void;
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
     * `inference.captureModelHttpRequestBodies` in `config.yml`. The
     * capture is purely a tap — the forwarded bytes are unchanged and
     * SSE keeps streaming.
     */
    readonly captureModelHttpRequestBodies?: boolean;
    /**
     * Directory under which capture files are written when
     * {@link captureModelHttpRequestBodies} is true. Created on demand. Files are
     * named `<isoTs>-<reqId>.req.log` / `.resp.log`.
     */
    readonly captureDir?: string;
}

/**
 * Headers stripped from inbound requests before forwarding. Inbound
 * auth headers must never leak to the upstream — this proxy is the
 * *only* component that holds the real API key. We strip every form
 * we know about (`authorization`, `x-api-key`, `x-goog-api-key`) so
 * a misconfigured agent can't accidentally pass through whatever it
 * had on hand. Hop-by-hop headers are dropped so node sets them itself
 * for the outbound request.
 */
const HEADERS_TO_STRIP = new Set([
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    "host",
    "connection",
    "content-length",
]);

/**
 * Header names that — once `applyAuth` has set them — must never be
 * echoed verbatim into capture dumps. Matches the set of auth-style
 * headers we know about; values are replaced with `[redacted]` in
 * the on-disk dump even though the rest of the headers survive.
 */
const HEADERS_TO_REDACT_IN_CAPTURE = new Set(["authorization", "x-api-key", "x-goog-api-key"]);

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
            this.config.captureModelHttpRequestBodies === true
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
        provider.applyAuth(headers);
        headers.host = upstreamHost;

        const fullUrl = `${url.origin}${path}`;
        const capture = this.openCapture(req.method ?? "GET", fullUrl, headers);

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
                    const respBody = writeResponseHeader(capture.respFile, upstreamRes);
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
                            respBody.write(chunk);
                        });
                        decompressor.on("end", () => {
                            respBody.end();
                        });
                        decompressor.on("error", (err) => {
                            this.config.log.error(
                                `llm proxy capture ${capture.reqId} decompress error: ${err.message}`,
                            );
                            respBody.abort(`decompress error: ${err.message}`);
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
                            respBody.write(chunk);
                        });
                        const closeRespFile = (): void => {
                            respBody.end();
                        };
                        respTap.on("end", closeRespFile);
                        respTap.on("close", closeRespFile);
                    }
                    respTap.on("error", (err) => {
                        this.config.log.error(
                            `llm proxy capture ${capture.reqId} response tap error: ${err.message}`,
                        );
                        respBody.abort(`response tap error: ${err.message}`);
                    });
                    capture.respBody = respBody;
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
                if (capture.respBody !== undefined) {
                    capture.respBody.abort(`upstream error: ${err.message}`);
                } else {
                    capture.respFile.write(`[upstream error: ${err.message}]\n`);
                    capture.respFile.end();
                }
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
            const reqBody = capture.reqBody;
            const reqTap = new PassThrough();
            reqTap.on("data", (chunk: Buffer) => {
                reqBody.write(chunk);
            });
            const closeReqFile = (): void => {
                reqBody.end();
            };
            reqTap.on("end", closeReqFile);
            reqTap.on("close", closeReqFile);
            reqTap.on("error", (err) => {
                this.config.log.error(
                    `llm proxy capture ${capture.reqId} request tap error: ${err.message}`,
                );
                reqBody.abort(`request tap error: ${err.message}`);
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
        method: string,
        fullUrl: string,
        forwardedHeaders: Readonly<Record<string, string | string[]>>,
    ): CaptureHandles | undefined {
        if (this.config.captureModelHttpRequestBodies !== true) {
            return undefined;
        }
        const dir = this.config.captureDir;
        if (dir === undefined || dir.length === 0) {
            this.config.log.warn(
                "llm proxy: captureModelHttpRequestBodies is true but captureDir is unset — capture skipped",
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
        // Do NOT echo auth headers into the dump — even though the
        // proxy is the holder of the real upstream key, a capture file
        // lying around with a live bearer token (or `x-api-key`,
        // `x-goog-api-key`, …) in it is a footgun. The forwarded
        // headers are otherwise inert.
        const safeHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(forwardedHeaders)) {
            if (HEADERS_TO_REDACT_IN_CAPTURE.has(k.toLowerCase())) {
                safeHeaders[k] = "[redacted]";
                continue;
            }
            safeHeaders[k] = v;
        }
        reqFile.write(formatHeaderBlock(`${method} ${fullUrl}`, safeHeaders));
        const reqBody = new BodyCapture(reqFile, pickContentType(safeHeaders));
        this.config.log.info(`llm proxy capture ${reqId} → ${reqPath} / ${respPath}`);
        return { reqId, reqFile, respFile, reqBody, respBody: undefined };
    }
}

/** Per-request capture handles passed between forward() helpers. */
interface CaptureHandles {
    readonly reqId: string;
    readonly reqFile: WriteStream;
    readonly respFile: WriteStream;
    readonly reqBody: BodyCapture;
    /**
     * Wrapper around the response body file. Created lazily once upstream
     * headers arrive (so the wrapper knows the response content-type and
     * can pretty-print JSON). Stays `undefined` if the upstream errors
     * before sending a response — in which case the upstream-error path
     * writes a plain error line straight to {@link respFile}.
     */
    respBody: BodyCapture | undefined;
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
 * Write an HTTP-style status line and headers to the response capture
 * file before the body bytes start arriving, and return a {@link
 * BodyCapture} that will receive the body chunks. Mirrors the
 * request-side header so each dump file is self-describing without
 * needing to look up its sibling.
 */
function writeResponseHeader(file: WriteStream, upstreamRes: IncomingMessage): BodyCapture {
    const status = upstreamRes.statusCode ?? 0;
    const message = upstreamRes.statusMessage ?? "";
    const statusLine = message.length > 0 ? `HTTP/1.1 ${status} ${message}` : `HTTP/1.1 ${status}`;
    file.write(formatHeaderBlock(statusLine, upstreamRes.headers));
    return new BodyCapture(file, pickContentType(upstreamRes.headers));
}

/**
 * Emit an HTTP-style header block: one request/status line, then one
 * header per line (`name: value`, repeated for multi-valued headers),
 * then a single blank line delimiting the body. The trailing newline
 * before the body keeps the file parseable with anything that follows
 * the same convention as a real HTTP message.
 */
function formatHeaderBlock(
    firstLine: string,
    headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): string {
    let out = `${firstLine}\n`;
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) {
            continue;
        }
        if (Array.isArray(value)) {
            for (const v of value) {
                out += `${name}: ${v}\n`;
            }
        } else {
            out += `${name}: ${value}\n`;
        }
    }
    out += "\n";
    return out;
}

/**
 * Pull the first `content-type` value out of a headers bag, normalized
 * to a plain string. Returns the empty string when the header is
 * missing — callers feed the result into {@link isJsonContentType},
 * which treats `""` as "not JSON".
 */
function pickContentType(
    headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): string {
    const raw = headers["content-type"];
    if (raw === undefined) {
        return "";
    }
    return Array.isArray(raw) ? (raw[0] ?? "") : raw;
}

/**
 * Whether the given `content-type` value should make us buffer the body
 * for pretty-printing. Matches plain `application/json` and any
 * `application/*+json` subtype (e.g. `application/vnd.api+json`); the
 * `;charset=...` suffix is tolerated. NDJSON and SSE are intentionally
 * not buffered — each line is meant to stand on its own and arrival
 * order matters for debug reading.
 */
function isJsonContentType(contentType: string): boolean {
    const base = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
    return base === "application/json" || base.endsWith("+json");
}

/**
 * Capture sink for a single request or response body. For JSON content
 * types it buffers chunks in memory and pretty-prints the parsed value
 * at {@link end}; for everything else it streams chunks straight to the
 * file as they arrive (good for SSE and large opaque blobs). Errors
 * mid-stream go through {@link abort}, which flushes any buffered raw
 * bytes before appending the error marker so partial debug data isn't
 * lost.
 */
class BodyCapture {
    private readonly file: WriteStream;
    private buffer: Buffer[] | null;
    private finished = false;

    constructor(file: WriteStream, contentType: string) {
        this.file = file;
        this.buffer = isJsonContentType(contentType) ? [] : null;
    }

    write(chunk: Buffer): void {
        if (this.finished) {
            return;
        }
        if (this.buffer !== null) {
            this.buffer.push(chunk);
            return;
        }
        this.file.write(chunk);
    }

    end(): void {
        if (this.finished) {
            return;
        }
        this.finished = true;
        if (this.buffer !== null) {
            const raw = Buffer.concat(this.buffer);
            this.buffer = null;
            try {
                const parsed = JSON.parse(raw.toString("utf8"));
                this.file.write(JSON.stringify(parsed, null, 2));
                this.file.write("\n");
            } catch {
                this.file.write(raw);
            }
        }
        this.file.end();
    }

    /** Flush any buffered bytes raw, append `[message]`, then close. */
    abort(message: string): void {
        if (this.finished) {
            return;
        }
        this.finished = true;
        if (this.buffer !== null && this.buffer.length > 0) {
            this.file.write(Buffer.concat(this.buffer));
        }
        this.buffer = null;
        this.file.write(`[${message}]\n`);
        this.file.end();
    }
}

/**
 * Build the proxy's provider table from already-resolved providers (key
 * + apiKey + npmPackage + optional apiEndpoint). The npm package decides
 * the auth style and the default upstream base via
 * {@link NPM_PROVIDER_PROFILES}; the explicit `apiEndpoint` overrides the
 * default when present (openai-compatible gateways require it). The
 * linter / startup validation is the primary gate, but this function
 * still re-derives the bare invariants the proxy depends on so a bug
 * upstream can't ship a malformed provider table to the forwarding hot
 * path.
 *
 * @throws Via {@link resolveUpstreamBase} when a provider's npm package
 *   is unsupported or an openai-compatible provider has no apiEndpoint.
 */
export function buildProviders(
    resolved: readonly ResolvedProvider[],
): Readonly<Record<string, ProviderConfig>> {
    const providers: Record<string, ProviderConfig> = {};
    for (const provider of resolved) {
        const profile = NPM_PROVIDER_PROFILES[provider.npmPackage];
        if (profile === undefined) {
            const supported = Object.keys(NPM_PROVIDER_PROFILES).join(", ");
            throw new Error(
                `inference.apiKeys.${provider.key}: unsupported npm package "${provider.npmPackage}" (supported: ${supported})`,
            );
        }
        const upstreamBase = resolveUpstreamBase(provider.npmPackage, provider.apiEndpoint);
        const apiKey = provider.apiKey;
        providers[provider.key] = {
            upstreamBase,
            applyAuth: (headers) => {
                profile.applyAuth(headers, apiKey);
            },
        };
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
