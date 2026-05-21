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
     * Master kill switch for the mail feature. `true` (default) →
     * the poller starts and the ms365 mail provider is registered
     * (so the core `mail_*` tools can dispatch to it). `false` → the
     * daemon skips mail entirely (no polls, no provider) regardless
     * of login state. Use this to keep ms365 logins around for
     * calendar while silencing mail.
     *
     * Send-safety (`mail.allowSend`, `mail.recipientWhitelist`) lives
     * in the **core** mail config — those keys are cross-provider and
     * not scoped to ms365.
     */
    readonly enabled: boolean;
    /**
     * When `true` (default), the daemon runs the mailbox poller that
     * emits `mail:ms365` events. When `false`, polling is skipped but
     * the provider stays registered — use this when the user wants
     * on-demand tool access (read, draft, send) without proactive
     * new-mail processing. Has no effect when {@link enabled} is `false`
     * (that disables the entire mail subsystem).
     */
    readonly polling: boolean;
    /**
     * Whitelist of mailbox addresses (own or shared) the poller
     * walks. Empty → every primary mailbox of every logged-in account
     * is polled; shared mailboxes are not touched. Non-empty → only
     * listed mailboxes are polled across every logged-in account.
     */
    readonly mailboxes: readonly string[];
    /** Minutes between successful polls. */
    readonly pollingIntervalMinutes: number;
    /** Base (minutes) for the exponential-backoff schedule on poll errors. */
    readonly pollingBackoffMinutes: number;
}

const DEFAULT_POLLING_INTERVAL_MINUTES = 15;
const DEFAULT_POLLING_BACKOFF_MINUTES = 1;
const DEFAULT_TENANT_ID = "common";

const DEFAULT_CALENDAR_REMINDER_MINUTES = 15;
const DEFAULT_CALENDAR_LOOKBACK_DAYS = 365;
const DEFAULT_CALENDAR_LOOKAHEAD_DAYS = 730;
// friendly-node-cron silently drops a bare "3am" suffix and parses
// "every sunday at 3am" as midnight — so we use the unambiguous
// colon-separated form which yields the correct 03:00 schedule.
const DEFAULT_CALENDAR_REFRESH_CRON = "every sunday at 03:00";

/**
 * The calendar feature's slice at `ms365.calendar.*`. Read by the
 * calendar poller at boot and by the create-event tool at call time.
 *
 * Like `Ms365MailConfig`, every value has a working default; a
 * missing `ms365:` block leaves the plugin operational on conservative
 * settings (primary calendar only, attendees silently dropped from
 * create-event, weekly Sunday refresh).
 */
export interface Ms365CalendarConfig {
    /**
     * Master kill switch for the calendar feature. `true` (default)
     * → the poller starts, the provider registers, and the `cal_*`
     * tools can dispatch to ms365. `false` → no poller, no provider
     * registration, and the calendar tools will fail closed for any
     * ms365-backed calendar (the cache for those rows persists but
     * goes stale).
     */
    readonly enabled: boolean;
    /**
     * Calendar names to subscribe to. Empty → primary calendar only.
     * Match is case-insensitive on the Graph `name` field; unknown
     * names are silently skipped (logged once at startup).
     *
     * Attendee-safety (`calendar.allowAttendees`) lives in the **core**
     * calendar config; it is cross-provider and not scoped to ms365.
     */
    readonly calendars: readonly string[];
    /** Default reminder window for events created via `cal_create_event`. */
    readonly defaultReminderMinutesBeforeStart: number;
    /** Minutes between successful incremental polls. */
    readonly pollingIntervalMinutes: number;
    /** Base (minutes) of the exponential-backoff schedule on poll errors. */
    readonly pollingBackoffMinutes: number;
    /**
     * Friendly-cron expression for the periodic full re-walk that
     * reconciles deletions via the scan-generation tag. Default
     * `"every sunday at 3am"` matches a typical low-traffic window;
     * raise or lower per environment.
     */
    readonly refreshCron: string;
    /** Delta window: how far back to surface events. Default 365 days. */
    readonly lookbackDays: number;
    /** Delta window: how far ahead to surface events. Default 730 days. */
    readonly lookaheadDays: number;
}

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
        enabled: ctx.config.getBool("ms365.mail.enabled", true) !== false,
        polling: ctx.config.getBool("ms365.mail.polling", true) !== false,
        mailboxes: readStringArray(ctx, "ms365.mail.mailboxes"),
        pollingIntervalMinutes:
            typeof interval === "number" && interval > 0
                ? interval
                : DEFAULT_POLLING_INTERVAL_MINUTES,
        pollingBackoffMinutes:
            typeof backoff === "number" && backoff > 0 ? backoff : DEFAULT_POLLING_BACKOFF_MINUTES,
    };
}

/**
 * Read the calendar feature's slice at `ms365.calendar.*`. Returns a
 * populated defaults object when the subtree is absent or partial.
 */
export function readMs365CalendarConfig(ctx: HostContext): Ms365CalendarConfig {
    const interval = ctx.config.getNumber(
        "ms365.calendar.pollingInterval",
        DEFAULT_POLLING_INTERVAL_MINUTES,
    );
    const backoff = ctx.config.getNumber(
        "ms365.calendar.pollingBackoff",
        DEFAULT_POLLING_BACKOFF_MINUTES,
    );
    const reminder = ctx.config.getNumber(
        "ms365.calendar.defaultReminderMinutesBeforeStart",
        DEFAULT_CALENDAR_REMINDER_MINUTES,
    );
    const lookbackRaw = ctx.config.getNumber(
        "ms365.calendar.lookbackDays",
        DEFAULT_CALENDAR_LOOKBACK_DAYS,
    );
    const lookaheadRaw = ctx.config.getNumber(
        "ms365.calendar.lookaheadDays",
        DEFAULT_CALENDAR_LOOKAHEAD_DAYS,
    );
    const refreshCron =
        ctx.config.getString("ms365.calendar.refreshCron", DEFAULT_CALENDAR_REFRESH_CRON) ??
        DEFAULT_CALENDAR_REFRESH_CRON;
    return {
        enabled: ctx.config.getBool("ms365.calendar.enabled", true) !== false,
        calendars: readStringArray(ctx, "ms365.calendar.calendars"),
        defaultReminderMinutesBeforeStart:
            typeof reminder === "number" && reminder >= 0
                ? reminder
                : DEFAULT_CALENDAR_REMINDER_MINUTES,
        pollingIntervalMinutes:
            typeof interval === "number" && interval > 0
                ? interval
                : DEFAULT_POLLING_INTERVAL_MINUTES,
        pollingBackoffMinutes:
            typeof backoff === "number" && backoff > 0 ? backoff : DEFAULT_POLLING_BACKOFF_MINUTES,
        refreshCron:
            typeof refreshCron === "string" && refreshCron.length > 0
                ? refreshCron
                : DEFAULT_CALENDAR_REFRESH_CRON,
        lookbackDays:
            typeof lookbackRaw === "number" && lookbackRaw > 0
                ? Math.floor(lookbackRaw)
                : DEFAULT_CALENDAR_LOOKBACK_DAYS,
        lookaheadDays:
            typeof lookaheadRaw === "number" && lookaheadRaw > 0
                ? Math.floor(lookaheadRaw)
                : DEFAULT_CALENDAR_LOOKAHEAD_DAYS,
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
