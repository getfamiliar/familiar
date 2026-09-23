import type { HostContext } from "@getfamiliar/shared";

/**
 * The plugin's slice of `config/config.yml`, read from the `tesla.*`
 * subtree. Every field has an operational default, so a missing
 * `tesla:` block is fine — the plugin is enabled by the presence of a
 * cached login (`data/tesla/auth.json`), not by config.
 */
export interface TeslaConfig {
    /**
     * How long {@link import("./tools/ResolveVehicle.js").resolveVehicle}
     * waits for a sleeping car to report `state === "online"` after a
     * wake-up before falling back to the cached vehicle data.
     */
    readonly wakeTimeoutSeconds: number;
    /** `deviceCountry` query param on every ownership.tesla.com call (ISO-3166 alpha-2). */
    readonly deviceCountry: string;
    /** `deviceLanguage` query param on every ownership.tesla.com call (ISO-639 alpha-2). */
    readonly deviceLanguage: string;
    /**
     * Locale passed as `httpLocale` on the subscription-invoice
     * endpoints and as `ttpLocale` on the charging GraphQL endpoint.
     * The two endpoints spell the same concept differently; see
     * {@link import("./api/OwnershipClient.js").OwnershipClient}.
     */
    readonly locale: string;
    /**
     * Value of the `x-tesla-user-agent` header. The ownership /
     * charging endpoints only answer to requests that look like the
     * Tesla mobile app, and the accepted values are pinned to app
     * releases — so this rots and is configurable rather than a
     * constant. A sudden 403 from the invoice endpoints is the first
     * thing to bump here.
     */
    readonly teslaAppUserAgent: string;
    /** Companion `User-Agent` for the same endpoints; rots for the same reason. */
    readonly userAgent: string;
}

const DEFAULT_WAKE_TIMEOUT_SECONDS = 30;
const DEFAULT_DEVICE_COUNTRY = "DE";
const DEFAULT_DEVICE_LANGUAGE = "de";
const DEFAULT_LOCALE = "de_DE";
const DEFAULT_TESLA_APP_USER_AGENT = "TeslaApp/4.28.3-2167";
const DEFAULT_USER_AGENT = "Tesla/1195 CFNetwork/1388 Darwin/22.0.0";

/**
 * Read the `tesla.*` subtree into a fully-defaulted {@link TeslaConfig}.
 * Values that are present but nonsensical (non-positive timeout, empty
 * string) fall back to the default rather than throwing — a typo in an
 * optional key should not take the daemon down.
 *
 * @param ctx Plugin host context providing the config service.
 * @returns The resolved configuration, never partial.
 */
export function readTeslaConfig(ctx: HostContext): TeslaConfig {
    const wakeTimeout = ctx.config.getNumber(
        "tesla.wakeTimeoutSeconds",
        DEFAULT_WAKE_TIMEOUT_SECONDS,
    );
    return {
        wakeTimeoutSeconds:
            typeof wakeTimeout === "number" && wakeTimeout > 0
                ? Math.floor(wakeTimeout)
                : DEFAULT_WAKE_TIMEOUT_SECONDS,
        deviceCountry: nonEmpty(ctx, "tesla.deviceCountry", DEFAULT_DEVICE_COUNTRY),
        deviceLanguage: nonEmpty(ctx, "tesla.deviceLanguage", DEFAULT_DEVICE_LANGUAGE),
        locale: nonEmpty(ctx, "tesla.locale", DEFAULT_LOCALE),
        teslaAppUserAgent: nonEmpty(ctx, "tesla.teslaAppUserAgent", DEFAULT_TESLA_APP_USER_AGENT),
        userAgent: nonEmpty(ctx, "tesla.userAgent", DEFAULT_USER_AGENT),
    };
}

/**
 * Read a string key, substituting the default for both "absent" and
 * "present but empty".
 *
 * @param ctx Plugin host context.
 * @param key Dotted config path.
 * @param fallback Value used when the key is missing or blank.
 * @returns A non-empty string.
 */
function nonEmpty(ctx: HostContext, key: string, fallback: string): string {
    const value = ctx.config.getString(key, fallback);
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Read `core.timezone`, defaulting to `UTC`. Mirrors the host's own
 * `readCoreTimezone` (`host/src/calendar/EventRenderer.ts`), which a
 * plugin cannot import — plugins reach host capabilities only through
 * {@link HostContext}. Used to project Tesla's epoch timestamps into
 * the user's wall clock before they reach the agent.
 *
 * @param ctx Plugin host context providing the config service.
 * @returns An IANA zone name; never empty.
 */
export function readTimezone(ctx: HostContext): string {
    const zone = ctx.config.getString("core.timezone", "UTC") ?? "UTC";
    return typeof zone === "string" && zone.length > 0 ? zone : "UTC";
}
