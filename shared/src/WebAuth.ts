/**
 * Trusted-proxy contract of the core webserver.
 *
 * A reverse proxy in front of the webserver (a user-run Authelia /
 * oauth2-proxy, or a plugin's own proxy such as the tailscale sidecar)
 * proves that a request went through it by sending
 * {@link PROXY_SECRET_HEADER} with a shared secret. Only then does the
 * webserver read the proxy's user header; without a matching secret,
 * identity headers are ignored. Shared because plugins register such
 * proxies through `ctx.web.registerTrustedProxy`.
 *
 * Also the contract of a web UI plugin's root controller
 * ({@link WebUiEnv}, see `PluginHostManifest.webUi`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Request header carrying a trusted proxy's shared secret (lowercase, as Hono / node normalize it). */
export const PROXY_SECRET_HEADER = "x-familiar-proxy-secret";

/** Minimum length of a trusted-proxy secret; shorter ones are rejected. */
export const MIN_PROXY_SECRET_LENGTH = 32;

/** A reverse proxy whose user header the webserver trusts once its secret matches. */
export interface TrustedProxyRegistration {
    /** Shared secret the proxy sends in {@link PROXY_SECRET_HEADER}; at least {@link MIN_PROXY_SECRET_LENGTH} characters. */
    readonly secret: string;
    /** Header holding the authenticated login (e.g. `Tailscale-User-Login`, `Remote-User`). Empty or absent means "no identity". */
    readonly userHeader: string;
    /** Optional header holding a display name (e.g. `Tailscale-User-Name`). */
    readonly nameHeader?: string;
    /**
     * Optional: where browsers reach the webserver through this proxy right
     * now (e.g. `https://familiar.<tailnet>.ts.net`), or null while it is
     * not serving. Used to build login links that work from the user's
     * other devices. Called on demand; must be cheap and must not throw.
     */
    readonly publicBaseUrl?: () => string | null;
    /**
     * Whether the proxy signs users in by itself: an allowed user who opens
     * {@link publicBaseUrl} is already authenticated (Tailscale identity,
     * an Authelia login page, …), so a login link is pointless there and is
     * not offered under that URL; the URL is listed as "signs in
     * automatically" instead. Default `false`: login links are built for
     * the proxy's URL.
     */
    readonly hasBuiltInAuth?: boolean;
}

/** Webserver hooks exposed to plugins as `ctx.web`. */
export interface WebApi {
    /**
     * Register this plugin as a trusted proxy of the webserver; its id is
     * the plugin id. Call it from **`prepare()`**. The host drops the
     * registration when the plugin restarts.
     *
     * @throws {Error} When the secret is shorter than
     *   {@link MIN_PROXY_SECRET_LENGTH}, the user header is empty, or the
     *   plugin already registered a proxy.
     */
    registerTrustedProxy(registration: TrustedProxyRegistration): void;
}

/** Who a request belongs to, as resolved by the core auth middleware. */
export interface WebPrincipal {
    /** Login as listed in `webserver.auth.users`. */
    readonly login: string;
    /** Display name from the proxy's name header, else the login. */
    readonly displayName: string;
    /** `session`, or the id of the trusted proxy that vouched for the login (`plugin:tailscale`, `config:authelia`). */
    readonly via: string;
}

/**
 * Node bindings the webserver passes on every request (`c.env`), the same
 * shape as `HttpBindings` of `@hono/node-server`. A UI controller may
 * hand them to node-style middleware (e.g. Vite's dev server) and answer
 * with `RESPONSE_ALREADY_SENT`.
 */
export interface WebUiBindings {
    readonly incoming: IncomingMessage;
    readonly outgoing: ServerResponse;
}

/**
 * Hono environment of a web UI plugin's root controller. Every request
 * reaching the controller passed the core auth middleware, so
 * `c.get("principal")` is always set.
 */
export interface WebUiEnv {
    Bindings: WebUiBindings;
    Variables: {
        /** The signed-in, allowlisted user. */
        principal: WebPrincipal;
        /** Whether the browser talks HTTPS (directly, or to a trusted proxy that says so). */
        isHttps: boolean;
    };
}
