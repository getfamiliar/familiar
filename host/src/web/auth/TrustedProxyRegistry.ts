import { createHash, timingSafeEqual } from "node:crypto";
import { MIN_PROXY_SECRET_LENGTH, type TrustedProxyRegistration } from "@getfamiliar/shared";

/** A trusted proxy with its origin, as the auth middleware matches it. */
export interface TrustedProxy extends TrustedProxyRegistration {
    /** `config:<name>` for a `webserver.auth.trustedProxies.<name>` entry, `plugin:<plugin-id>` for a registered one. */
    readonly id: string;
}

/** A public URL a proxy currently serves the webserver under. */
export interface PublicProxyUrl {
    /** Proxy id (`plugin:tailscale`, `config:authelia`). */
    readonly via: string;
    readonly url: string;
    /** Whether the proxy signs users in by itself (see `TrustedProxyRegistration.hasBuiltInAuth`). */
    readonly hasBuiltInAuth: boolean;
}

/** Stored entry: the proxy plus the sha256 digest of its secret, compared in constant time. */
interface StoredProxy {
    readonly proxy: TrustedProxy;
    readonly secretDigest: Buffer;
}

/**
 * All reverse proxies the webserver trusts: the ones from
 * `webserver.auth.trustedProxies` (replaced on every webserver start)
 * and the ones plugins registered via `ctx.web.registerTrustedProxy`
 * (dropped when the plugin restarts). One instance per host process.
 */
export class TrustedProxyRegistry {
    private configProxies: StoredProxy[] = [];
    private readonly pluginProxies = new Map<string, StoredProxy>();

    /**
     * Replace the config-defined proxies.
     *
     * @param proxies Entries named `config:<name>`.
     * @throws {Error} When an entry is invalid (see {@link validateProxy}).
     */
    setConfigProxies(proxies: readonly TrustedProxy[]): void {
        this.configProxies = proxies.map((proxy) => store(proxy));
    }

    /**
     * Register a plugin's proxy under `plugin:<pluginId>`.
     *
     * @param pluginId Registering plugin.
     * @param registration Secret and headers.
     * @throws {Error} When the plugin already registered one, or the entry is invalid.
     */
    registerPluginProxy(pluginId: string, registration: TrustedProxyRegistration): void {
        if (this.pluginProxies.has(pluginId)) {
            throw new Error(
                `plugin "${pluginId}" already registered a trusted proxy; ctx.web.registerTrustedProxy may be called once per plugin`,
            );
        }
        this.pluginProxies.set(pluginId, store({ ...registration, id: `plugin:${pluginId}` }));
    }

    /**
     * Drop whatever `pluginId` registered, so it can register again after
     * a restart. No-op when it registered nothing.
     *
     * @param pluginId The restarting plugin.
     */
    unregisterPlugin(pluginId: string): void {
        this.pluginProxies.delete(pluginId);
    }

    /**
     * Find the proxy whose secret equals `secret`. Every entry is compared
     * (constant time per entry, no early exit) so the timing does not
     * reveal which or how many proxies exist.
     *
     * @param secret Value of the proxy-secret request header.
     * @returns The matching proxy, or null.
     */
    match(secret: string): TrustedProxy | null {
        const digest = sha256(secret);
        let found: TrustedProxy | null = null;
        for (const entry of [...this.configProxies, ...this.pluginProxies.values()]) {
            if (timingSafeEqual(entry.secretDigest, digest) && found === null) {
                found = entry.proxy;
            }
        }
        return found;
    }

    /**
     * Public base URLs the proxies currently serve the webserver under
     * (see {@link TrustedProxyRegistration.publicBaseUrl}). A getter that
     * throws or returns an empty value is skipped.
     *
     * @returns `{ via, url, hasBuiltInAuth }` per serving proxy, trailing
     *   slashes removed.
     */
    listPublicBaseUrls(): readonly PublicProxyUrl[] {
        const urls: PublicProxyUrl[] = [];
        for (const { proxy } of [...this.configProxies, ...this.pluginProxies.values()]) {
            let url: string | null = null;
            try {
                url = proxy.publicBaseUrl?.() ?? null;
            } catch {
                // A broken getter must not break login-link creation; the
                // proxy is simply not offered as a URL.
                url = null;
            }
            if (url !== null && url.trim() !== "") {
                urls.push({
                    via: proxy.id,
                    url: url.trim().replace(/\/+$/, ""),
                    hasBuiltInAuth: proxy.hasBuiltInAuth === true,
                });
            }
        }
        return urls;
    }

    /**
     * Ids of every trusted proxy, for status output.
     *
     * @returns Config proxies first, then plugin proxies.
     */
    listIds(): readonly string[] {
        return [...this.configProxies, ...this.pluginProxies.values()].map(
            (entry) => entry.proxy.id,
        );
    }
}

/**
 * Validate a proxy and precompute its secret digest.
 *
 * @param proxy The proxy.
 * @returns The stored entry.
 * @throws {Error} When the proxy is invalid.
 */
function store(proxy: TrustedProxy): StoredProxy {
    validateProxy(proxy);
    return { proxy, secretDigest: sha256(proxy.secret) };
}

/**
 * Check a proxy's secret length and user header.
 *
 * @param proxy The proxy.
 * @throws {Error} Naming the proxy and the problem.
 */
export function validateProxy(proxy: TrustedProxy): void {
    if (proxy.secret.length < MIN_PROXY_SECRET_LENGTH) {
        throw new Error(
            `trusted proxy "${proxy.id}": secret must be at least ${MIN_PROXY_SECRET_LENGTH} characters`,
        );
    }
    if (proxy.userHeader.trim() === "") {
        throw new Error(`trusted proxy "${proxy.id}": userHeader must not be empty`);
    }
}

/**
 * @param value Text to hash.
 * @returns Its sha256 digest.
 */
function sha256(value: string): Buffer {
    return createHash("sha256").update(value, "utf-8").digest();
}
