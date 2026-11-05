import { DEFAULT_WEBSERVER_HOST, DEFAULT_WEBSERVER_PORT } from "@getfamiliar/shared";
import type { HostConfigService } from "../../utils/ConfigService.js";
import { detectLanBaseUrls } from "./HostAddresses.js";
import type { TrustedProxyRegistry } from "./TrustedProxyRegistry.js";
import { isAllowedLogin, LOGIN_TOKEN_TTL_MS, readWebAuthSettings } from "./WebAuth.js";
import type { WebSessionStore } from "./WebSessionStore.js";

/**
 * Where a login-link URL comes from, which tells how likely it works on
 * the user's device:
 *
 * - `configured` — listed in `webserver.lanUrls`, confirmed by the user.
 * - `custom` — the base URL the caller passed.
 * - `plugin:<id>` / `config:<name>` — a trusted proxy's public URL (one without built-in auth).
 * - `detected` — guessed from the host name / network interfaces; may be unreachable.
 * - `local` — `localhost`, works only on the machine running familiar.
 */
export type LoginLinkSource = string;

/** One address the login link can be opened under. */
export interface LoginLinkUrl {
    readonly via: LoginLinkSource;
    readonly url: string;
}

/** A URL under which a proxy signs the user in by itself: no token, no link needed. */
export interface AutoSignInUrl {
    /** Proxy id, e.g. `plugin:tailscale`. */
    readonly via: string;
    /** Base URL with a trailing slash, e.g. `https://familiar.example.ts.net/`. */
    readonly url: string;
}

/** A freshly minted one-time login link. */
export interface LoginLink {
    readonly login: string;
    readonly expiresAt: Date;
    /** The same token under every address it may work under, most reliable first, `local` last. */
    readonly loginLinks: readonly LoginLinkUrl[];
    /** Addresses where the user is signed in automatically (no link needed). */
    readonly autoSignIn: readonly AutoSignInUrl[];
    /** Caveats about reachability (WSL2, guessed addresses, …). */
    readonly notes: readonly string[];
}

/** Inputs of {@link createLoginLink}. */
export interface CreateLoginLinkOptions {
    readonly config: HostConfigService;
    readonly sessions: WebSessionStore;
    /** Source of the proxies' public URLs; omit when none are known (CLI without daemon state). */
    readonly proxies?: TrustedProxyRegistry;
    /** Login to sign in as; default: the first of `webserver.auth.users`. */
    readonly user?: string;
    /** Extra base URL to build the link for (e.g. the machine's LAN address). */
    readonly baseUrl?: string;
}

/**
 * Mint a one-time login token and collect every address the user can
 * reach the web UI under: login links for direct access (configured LAN
 * URLs, a caller-supplied base URL, proxies without built-in auth,
 * detected LAN addresses, `localhost`) and plain URLs of proxies that sign
 * the user in by themselves. Shared by `familiar web login` and the
 * `web_login_link` agent tool.
 *
 * @param options Config, stores, login and optional base URL.
 * @returns The link.
 * @throws {Error} When the login is not listed in `webserver.auth.users`
 *   (or the list is empty), or a base URL is not http(s).
 */
export async function createLoginLink(options: CreateLoginLinkOptions): Promise<LoginLink> {
    const { config } = options;
    const settings = readWebAuthSettings(config);
    const login = options.user?.trim() || settings.users[0];
    if (login === undefined || !isAllowedLogin(settings, login)) {
        throw new Error(
            `"${String(login)}" is not listed in webserver.auth.users (${settings.users.join(", ")})`,
        );
    }
    const port = config.getNumber("webserver.port", DEFAULT_WEBSERVER_PORT);
    const bindHost = config.getString("webserver.host", DEFAULT_WEBSERVER_HOST);

    const bases: LoginLinkUrl[] = [];
    const autoSignIn: AutoSignInUrl[] = [];
    for (const url of config.getStringList("webserver.lanUrls", [])) {
        bases.push({ via: "configured", url: normalizeBaseUrl(url) });
    }
    if (options.baseUrl !== undefined && options.baseUrl.trim() !== "") {
        bases.push({ via: "custom", url: normalizeBaseUrl(options.baseUrl) });
    }
    for (const proxy of options.proxies?.listPublicBaseUrls() ?? []) {
        if (proxy.hasBuiltInAuth) {
            autoSignIn.push({ via: proxy.via, url: `${proxy.url}/` });
        } else {
            bases.push({ via: proxy.via, url: proxy.url });
        }
    }
    const lan = detectLanBaseUrls(port, bindHost);
    for (const detected of lan.urls) {
        bases.push({ via: "detected", url: detected.url });
    }
    bases.push({ via: "local", url: `http://localhost:${port}` });

    const token = await options.sessions.createLoginToken(login, LOGIN_TOKEN_TTL_MS);
    return {
        login,
        expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
        loginLinks: dedupeByUrl(bases).map((base) => ({
            via: base.via,
            url: `${base.url}/login/${token}`,
        })),
        autoSignIn,
        notes: lan.notes,
    };
}

/**
 * Drop later entries whose URL already appeared (a configured LAN URL may
 * equal a detected one); the first, more reliable source wins.
 *
 * @param bases Base URLs in priority order.
 * @returns The unique ones.
 */
function dedupeByUrl(bases: readonly LoginLinkUrl[]): LoginLinkUrl[] {
    const seen = new Set<string>();
    return bases.filter((base) => {
        if (seen.has(base.url)) {
            return false;
        }
        seen.add(base.url);
        return true;
    });
}

/**
 * Validate and normalize a base URL.
 *
 * @param raw Base URL, e.g. `http://192.168.1.20:8080/`.
 * @returns Origin plus path without trailing slash.
 * @throws {Error} When it is not an http(s) URL.
 */
function normalizeBaseUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new Error(`base URL "${raw}" is not a valid URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`base URL "${raw}" must start with http:// or https://`);
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}
