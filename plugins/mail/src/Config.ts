import type { HostContext } from "@getfamiliar/shared";

/** Plugin-wide knobs read from the `mail.*` config subtree. */
export interface MailConfig {
    /** Minutes between successful polls of each active provider. */
    readonly pollingIntervalMinutes: number;
    /** Base (minutes) for the exponential-backoff schedule on poll errors. */
    readonly pollingBackoffMinutes: number;
}

/**
 * The o365 provider's slice of `mail.o365.*`. Read by the provider at
 * boot and by the send/draft tools at call time.
 */
export interface O365Config {
    /**
     * Whitelist of mailbox addresses (own or shared) the provider
     * polls. Empty → every primary mailbox of every logged-in account
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

const DEFAULT_POLLING_INTERVAL_MINUTES = 15;
const DEFAULT_POLLING_BACKOFF_MINUTES = 1;
const DEFAULT_TENANT_ID = "common";

/**
 * Read plugin-wide options from `config.yml`. Never returns `null`:
 * defaults are operational (15-minute polling, 1-minute backoff), so
 * a missing `mail:` block is fine and means "use defaults." Real
 * enablement is gated by login state, not by the config subtree.
 */
export function readMailConfig(ctx: HostContext): MailConfig {
    const interval = ctx.config.getNumber("mail.pollingInterval", DEFAULT_POLLING_INTERVAL_MINUTES);
    const backoff = ctx.config.getNumber("mail.pollingBackoff", DEFAULT_POLLING_BACKOFF_MINUTES);
    return {
        pollingIntervalMinutes:
            typeof interval === "number" && interval > 0
                ? interval
                : DEFAULT_POLLING_INTERVAL_MINUTES,
        pollingBackoffMinutes:
            typeof backoff === "number" && backoff > 0 ? backoff : DEFAULT_POLLING_BACKOFF_MINUTES,
    };
}

/**
 * Read the o365 provider's slice at `mail.o365.*`. Returns a
 * populated defaults object when the subtree is absent or partial —
 * missing keys become defaults rather than disabling the provider.
 */
export function readO365Config(ctx: HostContext): O365Config {
    return {
        mailboxes: readStringArray(ctx, "mail.o365.mailboxes"),
        allowSend: ctx.config.getBool("mail.o365.allowSend", false) === true,
        recipientWhitelist: readStringArray(ctx, "mail.o365.recipientWhitelist"),
        clientId: ctx.config.getString("mail.o365.clientId", "") ?? "",
        tenantId:
            ctx.config.getString("mail.o365.tenantId", DEFAULT_TENANT_ID) ?? DEFAULT_TENANT_ID,
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
