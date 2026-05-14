import type { HostContext } from "effective-assistant-shared";

/** Plugin-wide knobs read from the `mail.*` config subtree. */
export interface MailConfig {
    /** Minutes between successful polls of each active provider. */
    readonly pollingIntervalMinutes: number;
    /** Base (minutes) for the exponential-backoff schedule on poll errors. */
    readonly pollingBackoffMinutes: number;
}

/**
 * Per-provider config slice. Every provider (`o365`, future `gmail`,
 * `proton`, …) accepts the same shape; provider-specific keys land
 * here only when a concrete provider proves it needs them.
 */
export interface ProviderConfig {
    /**
     * When `true`, the initial watermark is set to "now" for every
     * mailbox the first time it is observed — historical mail is
     * ignored. Right setting for non-zero-inbox accounts. Default
     * `false`, so the plugin walks the whole inbox once on first
     * start of a fresh mailbox.
     */
    readonly onlyNew: boolean;
    /**
     * Optional whitelist of mailbox addresses (own or shared) the
     * provider polls. When empty, every primary mailbox of every
     * logged-in account is polled and shared mailboxes are not
     * touched. When non-empty, only listed mailboxes are polled —
     * across every logged-in account.
     */
    readonly mailboxes: readonly string[];
}

const DEFAULT_POLLING_INTERVAL_MINUTES = 15;
const DEFAULT_POLLING_BACKOFF_MINUTES = 1;

/**
 * Read plugin-wide options from `config.yml`. Never returns `null`:
 * defaults are operational (15-minute polling, 1-minute backoff), so
 * a missing `mail:` block is fine and means "use defaults." Real
 * enablement is gated by MCP availability + login state, not by the
 * config subtree's presence.
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
 * Read a provider's config slice at `mail.<providerId>.*`. Returns a
 * populated defaults object when the subtree is absent or partial —
 * missing keys become defaults rather than disabling the provider.
 */
export function getProviderConfig(ctx: HostContext, providerId: string): ProviderConfig {
    const onlyNew = ctx.config.getBool(`mail.${providerId}.onlyNew`, false);
    const raw = ctx.config.getArray(`mail.${providerId}.mailboxes`, []);
    const mailboxes: string[] = [];
    for (const entry of raw) {
        if (typeof entry === "string" && entry.length > 0) {
            mailboxes.push(entry);
        }
    }
    return {
        onlyNew: typeof onlyNew === "boolean" ? onlyNew : false,
        mailboxes,
    };
}
