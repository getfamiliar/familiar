import type { HostContext } from "@getfamiliar/shared";
import { type AppRegistration, DEFAULT_APP } from "./auth/AppRegistration.js";

/**
 * Auth options shared across every Microsoft 365 feature in this
 * plugin. Read from the `ms365.*` top-level keys (without a feature
 * suffix) because the same login covers mail today and will cover
 * calendar next.
 */
export interface Ms365AuthConfig {
    /**
     * Override the hardcoded multi-tenant client id. Empty string →
     * use the project-default app. Plugin README explains the trust
     * model and how to register an own app.
     */
    readonly clientId: string;
    /**
     * Override the OAuth authority tenant. Default `"common"` works
     * for multi-tenant apps and accepts any work-or-school account.
     * Use a tenant GUID for a single-tenant own app.
     */
    readonly tenantId: string;
}

/**
 * The mail feature's slice at `ms365.mail.*`. Read by the poller at
 * boot and by the send/draft tools at call time.
 */
export interface Ms365MailConfig {
    /**
     * Whitelist of mailbox addresses (own or shared) the poller
     * walks. Empty → every primary mailbox of every logged-in account
     * is polled; shared mailboxes are not touched. Non-empty → only
     * listed mailboxes are polled across every logged-in account.
     */
    readonly mailboxes: readonly string[];
    /**
     * When `true`, the send-* tools dispatch immediately. When
     * `false` (the default), every send becomes a draft instead — a
     * safety net for the early-life agent.
     */
    readonly allowSend: boolean;
    /**
     * Recipient whitelist applied **only when {@link allowSend} is
     * `true`**. Each entry is either a full address (`user@host`) or
     * a domain anchor (`@host`); a recipient matches if its address
     * equals an entry verbatim or shares a domain with an `@host`
     * entry. Empty (default) → allowSend with no whitelist means
     * "anything goes" once the master switch is on.
     */
    readonly recipientWhitelist: readonly string[];
    /** Minutes between successful polls. */
    readonly pollingIntervalMinutes: number;
    /** Base (minutes) for the exponential-backoff schedule on poll errors. */
    readonly pollingBackoffMinutes: number;
}

const DEFAULT_POLLING_INTERVAL_MINUTES = 15;
const DEFAULT_POLLING_BACKOFF_MINUTES = 1;
const DEFAULT_TENANT_ID = "common";

/**
 * Read the shared auth slice at `ms365.*`. Returns a populated
 * defaults object when the subtree is absent — missing keys become
 * defaults rather than disabling the plugin. Real enablement is gated
 * by login state, not by the config subtree.
 */
export function readMs365AuthConfig(ctx: HostContext): Ms365AuthConfig {
    return {
        clientId: ctx.config.getString("ms365.clientId", "") ?? "",
        tenantId: ctx.config.getString("ms365.tenantId", DEFAULT_TENANT_ID) ?? DEFAULT_TENANT_ID,
    };
}

/**
 * Read the mail feature's slice at `ms365.mail.*`. Returns a
 * populated defaults object when the subtree is absent or partial —
 * defaults are operational (15-minute polling, 1-minute backoff,
 * drafts-only sending), so a missing `ms365:` block is fine.
 */
export function readMs365MailConfig(ctx: HostContext): Ms365MailConfig {
    const interval = ctx.config.getNumber(
        "ms365.mail.pollingInterval",
        DEFAULT_POLLING_INTERVAL_MINUTES,
    );
    const backoff = ctx.config.getNumber(
        "ms365.mail.pollingBackoff",
        DEFAULT_POLLING_BACKOFF_MINUTES,
    );
    return {
        mailboxes: readStringArray(ctx, "ms365.mail.mailboxes"),
        allowSend: ctx.config.getBool("ms365.mail.allowSend", false) === true,
        recipientWhitelist: readStringArray(ctx, "ms365.mail.recipientWhitelist"),
        pollingIntervalMinutes:
            typeof interval === "number" && interval > 0
                ? interval
                : DEFAULT_POLLING_INTERVAL_MINUTES,
        pollingBackoffMinutes:
            typeof backoff === "number" && backoff > 0 ? backoff : DEFAULT_POLLING_BACKOFF_MINUTES,
    };
}

function readStringArray(ctx: HostContext, key: string): readonly string[] {
    const raw = ctx.config.getArray(key, []);
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry === "string" && entry.length > 0) {
            out.push(entry);
        }
    }
    return out;
}

/**
 * Merge the optional config overrides into the default app
 * registration. An empty `clientId` from config means "keep default"
 * — the field is present in the example file but blank by default,
 * so we don't want a placeholder string to nuke the working hardcoded
 * app id.
 */
export function resolveAppRegistration(auth: Ms365AuthConfig): AppRegistration {
    return {
        clientId: auth.clientId.length > 0 ? auth.clientId : DEFAULT_APP.clientId,
        tenantId: auth.tenantId.length > 0 ? auth.tenantId : DEFAULT_APP.tenantId,
    };
}
