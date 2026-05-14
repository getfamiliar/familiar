import type { CommandDef } from "citty";
import type { EmitHandle, HostContext, McpClient, NewEvent } from "effective-assistant-shared";
import type { MailConfig, ProviderConfig } from "../Config.js";
import type { WatermarkStore } from "../Watermark.js";

/**
 * Result of {@link MailProvider.isLoggedIn}. `detail` is a single
 * line of human-readable status (account emails, error message, …)
 * for the daemon log and the `status` CLI.
 */
export interface LoginStatus {
    readonly ok: boolean;
    readonly detail: string;
}

/**
 * Everything a provider's {@link MailProvider.pollOnce} body needs.
 * The orchestration core (`MailDaemon`) builds one of these per
 * active provider and reuses it across polls.
 */
export interface MailProviderDeps {
    readonly ctx: HostContext;
    /** The `mcp.yml` key the provider was matched to. */
    readonly mcpKey: string;
    /** Lazy-connect MCP SDK client; first method call opens the connection. */
    readonly client: McpClient;
    /** Plugin-wide options (interval, backoff). */
    readonly mail: MailConfig;
    /** This provider's slice of `mail.<providerId>.*`. */
    readonly provider: ProviderConfig;
    /** Shared watermark store; persists across daemon restarts. */
    readonly watermark: WatermarkStore;
    /** Scoped logger — prepends "mail/<providerId>: " in the daemon log. */
    readonly log: (msg: string) => void;
    /** Emit a `NewEvent` through the host's `ctx.events.emit` path. */
    readonly emit: (event: NewEvent) => Promise<EmitHandle>;
}

/**
 * Contract every concrete mail-MCP integration implements. Adding a
 * new provider (Gmail, Proton, IMAP, …) means dropping a new
 * implementation in `src/providers/<id>/` and registering it in
 * `src/providers/Registry.ts` — no edits to the orchestration core.
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
     * The MCP npm/pypi package name (or docker image) the provider
     * needs. Used by `MailDaemon` to find a matching `mcp.yml` entry
     * via `ctx.mcp.getList()`; the actual `mcp.yml` key is free to
     * be anything (e.g. `ms365`, `softeria-graph`, …).
     */
    readonly packageName: string;
    /** Probe login state by calling the provider's auth-check tool. */
    isLoggedIn(client: McpClient): Promise<LoginStatus>;
    /** Run one poll pass for every configured/discovered mailbox. */
    pollOnce(deps: MailProviderDeps): Promise<void>;
    /**
     * Build the citty subcommand mounted under `./cli.sh mail <id>`.
     * Accepts a nullable `mcpKey` so the subcommand is always
     * registered (so `--help` still surfaces it); the command's leaf
     * `run` prints an actionable error when the MCP is missing.
     */
    // biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
    buildCommands(ctx: HostContext, mcpKey: string | null): CommandDef<any>;
}
