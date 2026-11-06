import type { IncomingMessage } from "node:http";
import {
    type Logger,
    PROXY_SECRET_HEADER,
    type WebAuthPageView,
    type WebPrincipal,
    type WebUiEnv,
} from "@getfamiliar/shared";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { parse as parseCookieHeader } from "hono/utils/cookie";
import type { HostConfigService } from "../../utils/ConfigService.js";
import { decodeMimeEncodedWords } from "./MimeEncodedWord.js";
import type { TrustedProxy, TrustedProxyRegistry } from "./TrustedProxyRegistry.js";
import type { WebSessionStore } from "./WebSessionStore.js";

export type { WebPrincipal };

/**
 * Hono environment of the webserver app: the web UI contract
 * ({@link WebUiEnv}) plus `signedInAs` for the public login routes.
 */
export interface WebEnv {
    Bindings: WebUiEnv["Bindings"];
    Variables: WebUiEnv["Variables"] & {
        /**
         * Set on the public login routes: who is signed in already (an
         * allowed proxy login or a live session), or null.
         */
        signedInAs: WebPrincipal | null;
    };
}

/** Effective `webserver.auth.*` settings. */
export interface WebAuthSettings {
    /** Allowed logins, lowercased. */
    readonly users: readonly string[];
    /** Session lifetime. */
    readonly sessionTtlMs: number;
    /** Proxies from `webserver.auth.trustedProxies`. */
    readonly configProxies: readonly TrustedProxy[];
}

/** Dependencies of the auth middleware and routes. */
export interface WebAuthDeps {
    readonly settings: WebAuthSettings;
    readonly proxies: TrustedProxyRegistry;
    readonly sessions: WebSessionStore;
    readonly log: Logger;
}

/** Name of the session cookie. */
export const SESSION_COOKIE = "familiar_session";

/** Default of `webserver.auth.sessionDays`. */
export const DEFAULT_SESSION_DAYS = 30;

/** Lifetime of a login link minted by `familiar web login`. */
export const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Paths reachable without a principal (login flow). */
const PUBLIC_PATHS = /^\/(login(\/[^/]+)?|logout)$/;

/** Methods that never change state and skip the origin check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Milliseconds per day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read `webserver.auth.*` with defaults. Logins are lowercased so the
 * allowlist check is case-insensitive.
 *
 * @param config Host config.
 * @returns The settings.
 * @throws {Error} When `users` is empty (the webserver must not run
 *   open) or a trusted-proxy entry is malformed.
 */
export function readWebAuthSettings(config: HostConfigService): WebAuthSettings {
    const users = config
        .getStringList("webserver.auth.users", [])
        .map((login) => login.trim().toLowerCase())
        .filter((login) => login !== "");
    if (users.length === 0) {
        throw new Error(
            "webserver not started: webserver.auth.users is empty — list the logins allowed to use the web UI (e.g. your Tailscale login / e-mail)",
        );
    }
    const sessionDays = config.getNumber("webserver.auth.sessionDays", DEFAULT_SESSION_DAYS);
    const proxiesGroup = config.getMapping("webserver.auth.trustedProxies", {});
    const configProxies = Object.entries(proxiesGroup).map(([name, raw]) =>
        parseConfigProxy(name, raw),
    );
    return { users, sessionTtlMs: sessionDays * DAY_MS, configProxies };
}

/**
 * Parse one `webserver.auth.trustedProxies.<name>` entry.
 *
 * @param name Entry name.
 * @param raw Raw YAML value.
 * @returns The proxy with id `config:<name>`.
 * @throws {Error} When the entry is not a mapping or lacks `secret` / `userHeader`.
 */
function parseConfigProxy(name: string, raw: unknown): TrustedProxy {
    const key = `webserver.auth.trustedProxies.${name}`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`${key} must be a mapping with userHeader and secret`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.userHeader !== "string" || entry.userHeader.trim() === "") {
        throw new Error(`${key}.userHeader must be a non-empty header name`);
    }
    if (typeof entry.secret !== "string") {
        throw new Error(
            `${key}.secret is missing — set it with \`familiar config set ${key}.secret\``,
        );
    }
    if (entry.nameHeader !== undefined && typeof entry.nameHeader !== "string") {
        throw new Error(`${key}.nameHeader must be a header name`);
    }
    if (entry.publicUrl !== undefined && typeof entry.publicUrl !== "string") {
        throw new Error(`${key}.publicUrl must be a URL`);
    }
    if (entry.hasBuiltInAuth !== undefined && typeof entry.hasBuiltInAuth !== "boolean") {
        throw new Error(`${key}.hasBuiltInAuth must be true or false`);
    }
    const publicUrl = entry.publicUrl;
    return {
        id: `config:${name}`,
        secret: entry.secret,
        userHeader: entry.userHeader,
        nameHeader: entry.nameHeader,
        publicBaseUrl: publicUrl === undefined ? undefined : () => publicUrl,
        hasBuiltInAuth: entry.hasBuiltInAuth === true,
    };
}

/**
 * Whether `login` is on the allowlist.
 *
 * @param settings Auth settings.
 * @param login Login to check.
 * @returns True when allowed (case-insensitive).
 */
export function isAllowedLogin(settings: WebAuthSettings, login: string): boolean {
    return settings.users.includes(login.trim().toLowerCase());
}

/**
 * The auth middleware: run before every route. It
 *
 * 1. matches a {@link PROXY_SECRET_HEADER} against the trusted proxies
 *    (unknown secret → 401; identity headers are only read for a match),
 * 2. rejects state-changing requests whose `Origin` is not this host (CSRF),
 * 3. resolves the identity from the proxy's user header or the session
 *    cookie, and
 * 4. on the login routes sets `signedInAs` (allowed principal or null) and
 *    lets them through; elsewhere sets `principal`, answering 403 for a
 *    login not on the allowlist and 401 / a redirect to `/login` when
 *    there is no identity at all.
 *
 * @param deps Settings, proxy registry, session store, logger.
 * @returns The middleware.
 */
export function createAuthMiddleware(deps: WebAuthDeps): MiddlewareHandler<WebEnv> {
    return async (c, next) => {
        const request = authRequestFromContext(c);
        const secret = request.header(PROXY_SECRET_HEADER);
        let proxy: TrustedProxy | null = null;
        if (secret !== undefined) {
            proxy = deps.proxies.match(secret);
            if (proxy === null) {
                deps.log.warn(
                    `webserver: rejected ${c.req.method} ${c.req.path} — ${PROXY_SECRET_HEADER} matches no trusted proxy`,
                );
                return c.text("Unauthorized: unknown trusted-proxy secret", 401);
            }
        }
        c.set("isHttps", isHttpsRequest(request, proxy));
        if (!SAFE_METHODS.has(c.req.method) && !isSameOrigin(request, proxy)) {
            return c.text("Forbidden: cross-origin request", 403);
        }
        const identity = await resolveIdentity(request, deps, proxy);
        if (PUBLIC_PATHS.test(c.req.path)) {
            c.set("signedInAs", identity.kind === "allowed" ? identity.principal : null);
            return next();
        }
        if (identity.kind === "forbidden") {
            return forbidden(c, deps, identity.login, identity.via);
        }
        if (identity.kind === "none") {
            return unauthenticated(c);
        }
        c.set("principal", identity.principal);
        return next();
    };
}

/**
 * The parts of an incoming request the auth checks read. Built from a
 * Hono context for ordinary requests ({@link authRequestFromContext}) and
 * from node's raw `IncomingMessage` for WebSocket upgrades, which never
 * reach the Hono app ({@link authRequestFromIncoming}).
 */
interface AuthRequest {
    /** Header value by (case-insensitive) name, or undefined. */
    header(name: string): string | undefined;
    /** Cookie value by name, or undefined. */
    cookie(name: string): string | undefined;
    /** Whether the socket to this server itself is TLS. */
    readonly isTlsSocket: boolean;
}

/**
 * Adapt a Hono context to {@link AuthRequest}.
 *
 * @param c Request context.
 * @returns The accessor.
 */
function authRequestFromContext(c: Context<WebEnv>): AuthRequest {
    return {
        header: (name) => c.req.header(name),
        cookie: (name) => getCookie(c, name),
        isTlsSocket: new URL(c.req.url).protocol === "https:",
    };
}

/**
 * Adapt node's raw request (a WebSocket upgrade) to {@link AuthRequest}.
 *
 * @param req The upgrade request.
 * @returns The accessor.
 */
function authRequestFromIncoming(req: IncomingMessage): AuthRequest {
    const cookies = parseCookieHeader(req.headers.cookie ?? "");
    return {
        header: (name) => {
            const value = req.headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] : value;
        },
        cookie: (name) => cookies[name],
        isTlsSocket: "encrypted" in req.socket && req.socket.encrypted === true,
    };
}

/** Outcome of {@link authenticateUpgrade}. */
export type UpgradeAuthResult =
    | { readonly kind: "allowed"; readonly principal: WebPrincipal; readonly isHttps: boolean }
    | { readonly kind: "rejected"; readonly status: 401 | 403; readonly reason: string };

/**
 * Authenticate a WebSocket upgrade request with the same rules as the
 * HTTP middleware ({@link createAuthMiddleware}): trusted-proxy secret,
 * then proxy login or session cookie against the allowlist.
 *
 * Unlike ordinary GETs, an upgrade **must** carry a same-origin `Origin`
 * header: a handshake is a GET, and without this check any website the
 * user visits could open a socket with the user's session cookie
 * (cross-site WebSocket hijacking). Browsers always send `Origin` on
 * WebSocket handshakes.
 *
 * @param req The raw upgrade request.
 * @param deps Settings, proxy registry, session store, logger.
 * @returns The principal and HTTPS flag, or the status and reason to reject with.
 */
export async function authenticateUpgrade(
    req: IncomingMessage,
    deps: WebAuthDeps,
): Promise<UpgradeAuthResult> {
    const request = authRequestFromIncoming(req);
    const secret = request.header(PROXY_SECRET_HEADER);
    let proxy: TrustedProxy | null = null;
    if (secret !== undefined) {
        proxy = deps.proxies.match(secret);
        if (proxy === null) {
            return {
                kind: "rejected",
                status: 401,
                reason: "unknown trusted-proxy secret",
            };
        }
    }
    const origin = request.header("origin");
    if (origin === undefined || origin === "null" || !isSameOrigin(request, proxy)) {
        return { kind: "rejected", status: 403, reason: "cross-origin WebSocket handshake" };
    }
    const identity = await resolveIdentity(request, deps, proxy);
    if (identity.kind === "forbidden") {
        deps.log.warn(
            `webserver: rejected WebSocket of "${identity.login}" (via ${identity.via}) — not listed in webserver.auth.users`,
        );
        return {
            kind: "rejected",
            status: 403,
            reason: `"${identity.login}" is not listed in webserver.auth.users`,
        };
    }
    if (identity.kind === "none") {
        return { kind: "rejected", status: 401, reason: "not signed in" };
    }
    return {
        kind: "allowed",
        principal: identity.principal,
        isHttps: isHttpsRequest(request, proxy),
    };
}

/** Outcome of {@link resolveIdentity}. */
type Identity =
    | { readonly kind: "allowed"; readonly principal: WebPrincipal }
    | { readonly kind: "forbidden"; readonly login: string; readonly via: string }
    | { readonly kind: "none" };

/**
 * Determine who sent the request: the matched proxy's login first, else
 * the session cookie.
 *
 * @param request Request accessor.
 * @param deps Auth deps.
 * @param proxy Matched proxy, or null.
 * @returns Allowed principal, a login not on the allowlist, or nothing.
 */
async function resolveIdentity(
    request: AuthRequest,
    deps: WebAuthDeps,
    proxy: TrustedProxy | null,
): Promise<Identity> {
    const fromProxy = proxy === null ? null : principalFromProxy(request, proxy);
    if (fromProxy !== null) {
        return isAllowedLogin(deps.settings, fromProxy.login)
            ? { kind: "allowed", principal: fromProxy }
            : { kind: "forbidden", login: fromProxy.login, via: fromProxy.via };
    }
    const fromSession = await principalFromSession(request, deps);
    return fromSession === null ? { kind: "none" } : { kind: "allowed", principal: fromSession };
}

/** Renders a login-flow page as a full HTML document (from the selected web UI). */
export type AuthPageRenderer = (view: WebAuthPageView) => Promise<string>;

/** CLI command that prints a login link, as shown on the login pages. */
const LOGIN_COMMAND = "familiar web login";

/**
 * Content-Security-Policy of every login-flow page: no scripts and no
 * external resources at all, only inline styles and `data:` fonts /
 * images, forms posting to this origin only, no framing. The pages
 * stay inert even when a web UI renders them.
 */
export const AUTH_PAGE_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Mount the login flow: `GET /login` (who is signed in, or how to get a
 * link), `GET /login/:token`
 * (confirmation page; GET has no side effect so link previews cannot burn
 * the token), `POST /login/:token` (redeem → session cookie) and
 * `POST /logout`.
 *
 * The core decides every page, status and redirect; only the markup of
 * the pages may come from the selected web UI's `renderer`. Without a
 * renderer, or when it throws, the plain built-in pages are served.
 *
 * @param app The webserver app.
 * @param deps Settings, session store, logger.
 * @param renderer Auth-page renderer of the selected web UI, if any.
 */
export function mountLoginRoutes(
    app: Hono<WebEnv>,
    deps: WebAuthDeps,
    renderer?: AuthPageRenderer,
): void {
    const render = (c: Context<WebEnv>, view: WebAuthPageView, status: 200 | 401 = 200) =>
        renderAuthPage(c, deps, renderer, view, status);
    app.get("/login", (c) => {
        const principal = c.get("signedInAs");
        if (principal !== null) {
            return render(c, {
                kind: "signedIn",
                principal,
                continueUrl: "/",
                logoutAction: "/logout",
            });
        }
        return render(c, { kind: "signedOut", loginCommand: LOGIN_COMMAND });
    });
    app.get("/login/:token", (c) =>
        render(c, {
            kind: "confirmLoginLink",
            formAction: `/login/${encodeURIComponent(c.req.param("token"))}`,
        }),
    );
    app.post("/login/:token", async (c) => {
        const login = await deps.sessions.redeemLoginToken(c.req.param("token"));
        if (login === null) {
            return render(c, { kind: "invalidLoginLink", loginCommand: LOGIN_COMMAND }, 401);
        }
        if (!isAllowedLogin(deps.settings, login)) {
            return forbidden(c, deps, login, "login link");
        }
        const token = await deps.sessions.createSession(
            login,
            c.req.header("user-agent") ?? null,
            deps.settings.sessionTtlMs,
        );
        setCookie(c, SESSION_COOKIE, token, {
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
            secure: c.get("isHttps"),
            maxAge: Math.floor(deps.settings.sessionTtlMs / 1000),
        });
        deps.log.info(`webserver: "${login}" signed in with a login link`);
        return c.redirect("/", 303);
    });
    app.post("/logout", async (c) => {
        const token = getCookie(c, SESSION_COOKIE);
        if (token !== undefined) {
            await deps.sessions.deleteSessionByToken(token);
        }
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
        return c.redirect("/login", 303);
    });
}

/**
 * Answer with a login-flow page under {@link AUTH_PAGE_CSP}: the web UI's
 * markup when it renders one, else (or when it throws) the plain page.
 *
 * @param c Request context.
 * @param deps Auth deps (for the log line).
 * @param renderer The web UI's renderer, if any.
 * @param view The page to show.
 * @param status HTTP status.
 * @returns The response.
 */
async function renderAuthPage(
    c: Context<WebEnv>,
    deps: WebAuthDeps,
    renderer: AuthPageRenderer | undefined,
    view: WebAuthPageView,
    status: 200 | 401,
): Promise<Response> {
    const headers = { "content-security-policy": AUTH_PAGE_CSP, "cache-control": "no-store" };
    if (renderer !== undefined) {
        try {
            return c.html(await renderer(view), status, headers);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.log.error(
                `webserver: the web UI failed to render the "${view.kind}" login page: ${message} — serving the plain page`,
            );
        }
    }
    return c.html(plainAuthPage(view), status, headers);
}

/**
 * The built-in, unstyled login-flow pages.
 *
 * @param view The page to show.
 * @returns The page markup.
 */
function plainAuthPage(view: WebAuthPageView): ReturnType<typeof html> {
    switch (view.kind) {
        case "signedIn":
            return page(
                "Signed in",
                html`<p>
                        You are signed in as ${view.principal.displayName} (${view.principal.login}, via
                        ${view.principal.via}).
                    </p>
                    <p><a href="${view.continueUrl}">Continue to familiar</a></p>`,
            );
        case "signedOut":
            return page(
                "Sign in",
                html`<p>You are not signed in.</p>
                    <p>
                        On the machine running familiar, run <code>${view.loginCommand}</code> and open
                        the printed link here, or ask familiar in chat for a login link.
                    </p>`,
            );
        case "confirmLoginLink":
            return page(
                "Sign in",
                html`<form method="post" action="${view.formAction}">
                    <button type="submit">Sign in to familiar</button>
                </form>`,
            );
        case "invalidLoginLink":
            return page(
                "Sign in",
                html`<p>This login link is invalid, already used or expired.</p>
                    <p>Run <code>${view.loginCommand}</code> for a new one.</p>`,
            );
    }
}

/**
 * Read the login a matched proxy vouches for. Both headers may carry
 * RFC 2047 encoded words for non-ASCII text (Tailscale does this), which
 * are decoded.
 *
 * @param request Request accessor.
 * @param proxy The matched proxy.
 * @returns The principal, or null when the proxy sent no login (e.g. a
 *   tagged tailnet device) and the session cookie has to decide.
 */
function principalFromProxy(request: AuthRequest, proxy: TrustedProxy): WebPrincipal | null {
    const login = decodeMimeEncodedWords(request.header(proxy.userHeader) ?? "").trim();
    if (login === "") {
        return null;
    }
    const rawName = proxy.nameHeader === undefined ? "" : (request.header(proxy.nameHeader) ?? "");
    const name = decodeMimeEncodedWords(rawName).trim();
    return { login, displayName: name === "" ? login : name, via: proxy.id };
}

/**
 * Resolve the session cookie. A session whose login was removed from the
 * allowlist no longer counts.
 *
 * @param request Request accessor.
 * @param deps Auth deps.
 * @returns The principal, or null.
 */
async function principalFromSession(
    request: AuthRequest,
    deps: WebAuthDeps,
): Promise<WebPrincipal | null> {
    const token = request.cookie(SESSION_COOKIE);
    if (token === undefined) {
        return null;
    }
    const session = await deps.sessions.findSession(token);
    if (session === null || !isAllowedLogin(deps.settings, session.login)) {
        return null;
    }
    return { login: session.login, displayName: session.login, via: "session" };
}

/**
 * Whether the browser side of the connection is HTTPS. Behind a trusted
 * proxy that is the proxy's `X-Forwarded-Proto`; otherwise the request URL.
 *
 * @param request Request accessor.
 * @param proxy Matched proxy, or null.
 * @returns True for HTTPS.
 */
function isHttpsRequest(request: AuthRequest, proxy: TrustedProxy | null): boolean {
    if (proxy !== null) {
        return request.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
    }
    return request.isTlsSocket;
}

/**
 * CSRF check for state-changing requests: the `Origin` host must equal
 * the host the browser addressed (scheme is ignored, a TLS-terminating
 * proxy changes it). That is the `Host` header, or behind a trusted
 * proxy its `X-Forwarded-Host` when set (a proxy may rewrite `Host` to
 * its upstream). Without `Origin`, `Sec-Fetch-Site: same-origin` is
 * accepted.
 *
 * @param request Request accessor.
 * @param proxy Matched proxy, or null.
 * @returns True when the request comes from this site.
 */
function isSameOrigin(request: AuthRequest, proxy: TrustedProxy | null): boolean {
    const origin = request.header("origin");
    const forwardedHost =
        proxy === null ? undefined : request.header("x-forwarded-host")?.split(",")[0]?.trim();
    const host = forwardedHost || request.header("host");
    if (origin === undefined || origin === "null") {
        return request.header("sec-fetch-site") === "same-origin";
    }
    try {
        return host !== undefined && new URL(origin).host === host;
    } catch {
        return false;
    }
}

/**
 * Answer a request without identity: browsers navigating to a page are
 * redirected to `/login`, everything else gets 401.
 *
 * @param c Request context.
 * @returns The response.
 */
function unauthenticated(c: Context<WebEnv>): Response {
    const isPageNavigation =
        c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html");
    if (isPageNavigation) {
        return c.redirect("/login", 302);
    }
    return c.text("Unauthorized", 401);
}

/**
 * Answer a known login that is not on the allowlist.
 *
 * @param c Request context.
 * @param deps Auth deps (for the log line).
 * @param login The rejected login.
 * @param via Where the login came from.
 * @returns A 403 response.
 */
function forbidden(c: Context<WebEnv>, deps: WebAuthDeps, login: string, via: string): Response {
    deps.log.warn(
        `webserver: rejected "${login}" (via ${via}) — not listed in webserver.auth.users`,
    );
    return c.text(`Forbidden: "${login}" is not listed in webserver.auth.users`, 403);
}

/**
 * Minimal HTML page shell.
 *
 * @param title Page title.
 * @param body Escaped body markup.
 * @returns The page.
 */
export function page(title: string, body: ReturnType<typeof html>): ReturnType<typeof html> {
    return html`<!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>${title} · Familiar</title>
            </head>
            <body>
                <h1>${title}</h1>
                ${body}
            </body>
        </html>`;
}
