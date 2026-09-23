import { Buffer } from "node:buffer";
import { request as httpsRequest } from "node:https";
import { withConnectionRetry } from "../HttpRetry.js";

/**
 * One HTTP response as the auth flow needs it: status, headers, and
 * the body as text. Redirects are **not** followed — the SSO flow
 * carries its authorization code in the `Location` header of a 302 it
 * would otherwise lose.
 */
export interface TlsResponse {
    readonly status: number;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly body: string;
}

/** Options for {@link tlsRequest}. */
export interface TlsRequestOptions {
    readonly method: "GET" | "POST";
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
}

/**
 * Perform a single HTTPS request over a connection pinned to **TLS
 * 1.3**, without following redirects.
 *
 * The pin is the whole reason this helper exists instead of a plain
 * `fetch`. Tesla's SSO scopes the token it mints by the TLS version of
 * the connection that asked for it: a token obtained over TLS 1.2 comes
 * back Fleet-scoped, and every subsequent Owner API call answers `403
 * forbidden, see https://developer.tesla.com/docs/fleet-api`. Node
 * negotiates 1.3 with this host on its own today, but the failure mode
 * of a silent downgrade is a token that looks fine and works nowhere —
 * so we make it explicit and let the handshake fail loudly instead.
 *
 * Only the four `auth.tesla.com` calls go through here; everything else
 * in the plugin uses the global `fetch` like the rest of the repo.
 *
 * Connection-level failures (DNS, connect timeout, reset) are retried a
 * couple of times — they never reached Tesla, so this is not the
 * auto-retry-against-the-WAF that gets a login flagged. Any HTTP
 * answer, refusals included, is returned to the caller untouched.
 *
 * @param options Method, absolute URL, optional headers and body.
 * @returns The response status, headers and text body.
 * @throws When every attempt fails, or on any non-connection error.
 */
export function tlsRequest(options: TlsRequestOptions): Promise<TlsResponse> {
    return withConnectionRetry(() => sendOnce(options));
}

/**
 * Ceiling on one attempt. Without it a stalled socket inherits the
 * OS-level connect timeout (minutes on Linux), which in a CLI login
 * looks like a hang rather than a failure.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Issue exactly one request. {@link tlsRequest} wraps this with the
 * connection-level retry.
 *
 * @param options Method, absolute URL, optional headers and body.
 * @returns The response status, headers and text body.
 * @throws When the socket errors, times out, or the TLS handshake cannot reach 1.3.
 */
function sendOnce(options: TlsRequestOptions): Promise<TlsResponse> {
    const url = new URL(options.url);
    const payload = options.body === undefined ? undefined : Buffer.from(options.body, "utf8");
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (payload !== undefined) {
        headers["Content-Length"] = String(payload.byteLength);
    }

    return new Promise<TlsResponse>((resolve, reject) => {
        const req = httpsRequest(
            {
                method: options.method,
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port.length > 0 ? url.port : 443,
                path: `${url.pathname}${url.search}`,
                headers,
                minVersion: "TLSv1.3",
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => {
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString("utf8"),
                    });
                });
                res.on("error", reject);
            },
        );
        req.on("error", reject);
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            // `destroy` with an ErrnoException-shaped error so the
            // retry predicate treats a stall like any other connect
            // failure.
            req.destroy(
                Object.assign(
                    new Error(`request to ${url.host} timed out after ${REQUEST_TIMEOUT_MS}ms`),
                    { code: "ETIMEDOUT" },
                ),
            );
        });
        if (payload !== undefined) {
            req.write(payload);
        }
        req.end();
    });
}

/**
 * Collect the cookie pairs from a response's `set-cookie` headers into
 * the single `name=value; name=value` string a follow-up request's
 * `Cookie` header wants. Attributes (`Path`, `Expires`, `Secure`, …)
 * are dropped — the SSO flow only needs the session pair echoed back.
 *
 * @param response Response whose `set-cookie` headers to read.
 * @returns A `Cookie` header value, or the empty string when none were set.
 */
export function collectCookies(response: TlsResponse): string {
    const raw = response.headers["set-cookie"];
    if (raw === undefined) {
        return "";
    }
    const list = Array.isArray(raw) ? raw : [raw];
    const pairs: string[] = [];
    for (const entry of list) {
        const pair = entry.split(";", 1)[0]?.trim();
        if (pair !== undefined && pair.length > 0) {
            pairs.push(pair);
        }
    }
    return pairs.join("; ");
}
