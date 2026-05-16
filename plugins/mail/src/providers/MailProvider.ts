import type { CommandDef } from "citty";
import type { EmitHandle, HostContext, NewEvent } from "effective-assistant-shared";
import type { MailConfig } from "../Config.js";

/**
 * Inputs the orchestration core (`MailDaemon`) hands every active
 * provider on each `pollOnce` call. Plugin-wide config, a scoped log,
 * the emit callback. Provider-specific state (token caches, delta
 * cursors, mailbox→login maps) lives on the provider instance itself
 * — it's built up during {@link MailProvider.prepare} and reused
 * across polls.
 */
export interface MailProviderDeps {
    readonly ctx: HostContext;
    /** Plugin-wide options (interval, backoff). */
    readonly mail: MailConfig;
    /** Scoped logger — prepends "mail/<providerId>: " in the daemon log. */
    readonly log: (msg: string) => void;
    /** Emit a `NewEvent` through the host's `ctx.events.emit` path. */
    readonly emit: (event: NewEvent) => Promise<EmitHandle>;
}

/**
 * Contract every concrete mail integration implements. Adding a new
 * provider (Gmail, IMAP, …) means dropping a new implementation in
 * `src/providers/<id>/` and registering it in
 * `src/providers/Registry.ts` — no edits to the orchestration core.
 *
 * Lifecycle ordering:
 *
 * 1. `prepare(ctx)` is called once at daemon start. The provider
 *    validates its credentials (e.g. token caches), probes the
 *    mailboxes it'll poll, and reports whether anything is actually
 *    ready to run. Returns `false` to skip — the orchestration core
 *    logs the reason and moves on to the next provider.
 * 2. `pollOnce(deps)` is invoked repeatedly by the poll loop. Idempotent
 *    by bus-level idempotency key.
 * 3. `buildCommands(ctx)` is consulted once at CLI registration.
 */
export interface MailProvider {
    /**
     * Short, stable id. Drives `mail:<id>` topic, config-key prefix
     * (`mail.<id>.*`), CLI subcommand name (`./cli.sh mail <id> …`),
     * and watermark grouping. Must match `[a-z][a-z0-9]*`.
     */
    readonly id: string;
    /** Human-friendly name surfaced in logs and CLI output. */
    readonly displayName: string;
    /**
     * Async setup: validate credentials, probe targets, populate
     * any provider-local caches. Returns a status object the
     * orchestration core uses to decide whether to register this
     * provider with the poll loop. Errors thrown from `prepare` are
     * not fatal — they are logged and the provider is skipped, per
     * the memory rule [[feedback_skip_broken_logins_over_exit]].
     */
    prepare(ctx: HostContext): Promise<MailProviderPrepareResult>;
    /** Run one poll pass for every configured/discovered mailbox. */
    pollOnce(deps: MailProviderDeps): Promise<void>;
    /**
     * Build the citty subcommand mounted under `./cli.sh mail <id>`.
     * The CLI lives alongside the poll loop, so `prepare` must have
     * been called once before any subcommand body that touches
     * provider state.
     */
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
    buildCommands(ctx: HostContext): CommandDef<any>;
}

/**
 * Outcome of {@link MailProvider.prepare}: ready-or-not, plus a
 * human-readable status string for the daemon log. When `ok` is
 * `false` the provider is dropped from the poll loop for this daemon
 * run; the user fixes the cause (logging in, fixing config) and
 * restarts the daemon to retry.
 */
export interface MailProviderPrepareResult {
    readonly ok: boolean;
    /** One-line summary suitable for the daemon log. */
    readonly detail: string;
}
