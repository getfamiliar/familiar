import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CommandDef } from "citty";
import type { AgentRunRow } from "./AgentRun.js";
import type { CalendarApi } from "./Calendar.js";
import type { ChatFilter } from "./ChatMessage.js";
import type { ChatHandler, ChatUnsubscribe } from "./ChatMessageBus.js";
import type { ConfigService } from "./Config.js";
import type { EventFile, EventRow, NewEvent } from "./Event.js";
import type { Logger } from "./logging/Logger.js";
import type { MailApi } from "./Mail.js";
import type { MailStyleTemplate } from "./MailStyleTemplate.js";
import type { ModelMetaData, ModelProviderDescriptor } from "./ModelMetaData.js";
import type { StepResultRow } from "./StepResult.js";
import type { ToolLevel } from "./ToolLevel.js";
import type { ToolRunContext } from "./ToolRunner.js";
import type { WorkspaceWatcherApi } from "./WorkspaceFile.js";

export type { ChatHandler, Client as McpClient };

/**
 * Citty's `CommandDef` is generic over its `ArgsDef`, and that
 * generic appears in contravariant position on `run`. As a result a
 * `CommandDef<{ message: ... }>` is not assignable to the default
 * `CommandDef<ArgsDef>`. Citty's own `SubCommandsDef` works around
 * this with `CommandDef<any>`; we mirror that pattern in the plugin
 * manifest so plugins can return well-typed commands without
 * casting at the boundary.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's own SubCommandsDef usage.
export type AnyCommandDef = CommandDef<any>;

/**
 * Capabilities the host exposes to plugins. Passed into every plugin
 * lifecycle method (`start`, `commands`, `cronjobs`).
 *
 * **Plugins must reach host capabilities only through this object.**
 * Direct imports of `EventBus`, `PostgresConnection`, or other host
 * internals are not allowed in plugin code — the host owns those
 * lifecycles, and routing through ctx is what lets the host enforce
 * policy (later: assert a plugin only emits topics it declared, scope
 * logs by plugin id, gate writes through approval, etc.) and what
 * makes plugins unit-testable with a fake ctx.
 *
 * The contract is intentionally minimal today: only what the first
 * plugin (cli-chat) needs. New capabilities are added on demand as
 * plugins surface them.
 */
/**
 * Async function a plugin registers via
 * `ctx.events.registerContextProvider(fn)` to contribute per-event
 * situational knowledge to the handler that is about to run. Receives
 * the agentrun about to execute and its parent event; returns the
 * markdown body injected into the current-run user message, right after
 * the `# Runtime` block (see `buildRuntimeContextBlock`). The system
 * prompt itself stays static so it remains a cacheable prefix.
 * Returning `null`, `undefined`, or an empty/whitespace string
 * contributes nothing — useful for "only speak up when relevant"
 * providers.
 *
 * The function is called once per `buildRuntimeContextBlock` (i.e. once
 * per agentrun start). It runs in the host process — providers may close
 * over plugin-local services (DB handles, caches) without going through
 * the bastion. The PromptBuilder reaches the registry through the
 * bastion's `/event-context/` gateway, which fans out to every
 * registered provider in parallel; one bad provider must not poison
 * the prompt, so the gateway isolates rejections and per-call timeouts.
 */
export type EventContextProvider = (
    agentrun: AgentRunRow,
    event: EventRow,
) => Promise<string | null | undefined>;

/**
 * Optional callbacks passed alongside `ctx.events.emit`. Bundled into
 * an options object so additional per-emit hooks (e.g. cancellation,
 * progress) can be added without breaking the call signature.
 */
export interface EmitOptions {
    /**
     * Fired for every step row inserted into `stepresults` for this
     * event, in INSERT order. Errors thrown by the callback are caught
     * and logged so a buggy subscriber can't break the emit. When
     * omitted, no `stepresults_new` LISTEN is registered (zero
     * overhead).
     */
    readonly onStep?: (step: StepResultRow) => void | Promise<void>;
    /**
     * Fired whenever an `agentruns` row tied to this event is inserted
     * or transitions state. Receives the current {@link AgentRunRow} —
     * callers that only care about a specific transition must filter
     * on `row.state` themselves. Errors thrown by the callback are
     * caught and logged so a buggy subscriber can't break the emit.
     * When omitted, no `agentruns_changed` LISTEN is registered (zero
     * overhead).
     */
    readonly onAgentRun?: (row: AgentRunRow) => void | Promise<void>;
}

/**
 * Handle returned by `ctx.events.emit` once the event row has been
 * persisted. The two halves let callers act on the assigned id
 * immediately (e.g. registering it in an in-flight tracker) without
 * blocking on agent execution.
 */
export interface EmitHandle {
    /** Database id of the inserted event row, available immediately. */
    readonly id: string;
    /**
     * Resolves with the `result_text` of the last-settled agentrun
     * for the event (empty string if the handler produced no text).
     * Rejects with an `Error` carrying the failed agentrun's `error`
     * message when the event terminates in `failed`.
     *
     * Consumers MUST attach a `.then`/`.catch` (or `await`) to this
     * promise — otherwise a `failed` event surfaces as an unhandled
     * rejection.
     */
    readonly settled: Promise<string>;
}

/**
 * Metadata projection of one MCP entry as `ctx.mcp.getList()` exposes
 * it to plugins. Combines the `mcp.yml` key with the (non-sensitive)
 * identifying string of whatever provides the MCP: image for
 * `docker-mcp-registry`, package name for `npm` / `pypi`, URL for
 * `external`.
 */
export interface McpInfo {
    /** The top-level key in `mcp.yml`. Plugin-stable identifier. */
    readonly key: string;
    /** Source classifier; matches the `source` value in `mcp.yml`. */
    readonly source: string;
    /**
     * The image (docker-mcp-registry), bare package name (npm / pypi),
     * or URL (external) — whichever fits the source. One field so
     * callers can grep across sources uniformly; the source tag tells
     * them how to interpret it. Always non-empty.
     */
    readonly package: string;
}

export interface HostContext {
    /**
     * Emit an event into the bus. The returned outer promise resolves
     * once the row has been inserted (so the assigned id is known); the
     * `settled` field on the resolved handle reaches its terminal
     * state when the event finishes processing.
     *
     * Implementation subscribes to `events_state` before inserting to
     * avoid missing the terminal NOTIFY on a fast-processed event, and
     * tears the subscription down when `settled` resolves or rejects.
     *
     * Rejects with {@link DuplicateIdempotencyKeyError} when the event's
     * `idempotencyKey` collides with one already in the bus. Emitters
     * that re-derive a stable key (delta-poll re-walks, chat compaction)
     * should catch it and treat the collision as a no-op; the event
     * already exists.
     */
    readonly events: {
        emit(event: NewEvent, options?: EmitOptions): Promise<EmitHandle>;
        /**
         * Register an async function called once per agentrun start with
         * the agentrun row and its parent event. Its returned string is
         * injected below the `# Available tools` section in the system
         * prompt the handler runs against. Use this to teach the agent
         * situational facts a plugin knows — e.g. "the sender of this
         * mail is currently in a meeting", "this chat thread has 14
         * unread mails attached to it".
         *
         * Providers must be cheap to run: the PromptBuilder fans out to
         * every registered provider in parallel via the bastion's
         * `/event-context/` gateway and waits on them before assembling
         * the prompt. Slow providers delay the start of every agentrun.
         *
         * A provider that returns `null`, `undefined`, or whitespace
         * contributes nothing — typical for "only speak up when
         * relevant" cases. Exceptions thrown inside the provider are
         * isolated by the gateway and logged with the plugin id; the
         * prompt still assembles with the remaining providers' output.
         *
         * Plugins typically call this from their `start(ctx)` hook.
         */
        registerContextProvider(fn: EventContextProvider): void;
    };
    /**
     * Chat capabilities.
     *
     * `subscribe` taps the host's chatmessages NOTIFY stream for live
     * delivery. Delivery is at-least-once: when no listener returned
     * `true` during a message's lifetime, a future subscriber matching
     * the filter will receive it on registration via the bus's replay
     * pass. Listeners must therefore tolerate being called for an
     * already-displayed message; the typical pattern is to render and
     * return `true` unconditionally.
     *
     * `appendAssistantMessage` is a **history maintenance** helper,
     * not a parallel send API. The user → agent direction still flows
     * exclusively through events. Use it for recording an agent reply
     * that wasn't produced by the AgentRunner's `outputChat` path or
     * by `send_chat` — e.g. the result text of a direct cli-chat
     * handler call after `handle.settled` resolves.
     *
     * User-side messages have **no** equivalent post-emit helper: doing
     * a chatmessages INSERT after `events.emit` returns can race the
     * input-event watcher's claim (FK row-lock vs.
     * `FOR UPDATE SKIP LOCKED`) and strand the event in `pending`.
     * Use {@link NewEvent.userChatMessage} for atomic insertion of a
     * user chatmessage at emit time instead.
     */
    readonly chat: {
        subscribe(filter: ChatFilter, handler: ChatHandler): Promise<ChatUnsubscribe>;
        /**
         * Insert a `role='assistant'` chatmessage attached to `eventId`.
         * Channel is resolved via the event's
         * `preferred_chat_channel_id`. Safe to call only after the
         * event has settled (agentruns done / failed) — earlier calls
         * can deadlock the input-event watcher's claim.
         */
        appendAssistantMessage(eventId: string, text: string): Promise<void>;
    };
    /**
     * Per-event scratch directory operations. Each event the bus
     * persists has a private scratch dir at `/scratch/<event-id>/`
     * (bind-mounted into the agent container and every MCP container).
     * Files staged via `NewEvent.files` land there at emit time; this
     * surface lets plugin code *add* more files later, while an
     * agentrun for that event is still running — typically from inside
     * a {@link PluginTool} that fetches bytes on demand.
     *
     * Path resolution is host-side: callers pass the event id, the
     * host writes under its own `scratchDir`. The directory is
     * created if it doesn't exist yet (defensive — should always exist
     * for events that were emitted with `files`).
     */
    readonly scratch: {
        /**
         * Stage one or more files into `/scratch/<eventId>/`. Same
         * `EventFile` shape as `NewEvent.files`, same basename
         * validation, same per-file atomic write. Returns the absolute
         * agent-visible paths the files were written to (i.e.
         * `/scratch/<eventId>/<name>`), in input order.
         *
         * Throws if a `name` fails validation (path separator, `..`,
         * empty). Existing files with the same name are overwritten —
         * caller is responsible for unique names.
         */
        addFiles(eventId: string, files: readonly EventFile[]): Promise<readonly string[]>;
    };
    /**
     * The pino-style {@link Logger} for the plugin. Use `.info` for the
     * common case and `.debug` / `.warn` / `.error` for leveled output,
     * plus per-call structured fields. Already scoped to the plugin by
     * the host, so records carry a stable `component` tag without the
     * plugin doing anything.
     */
    readonly logger: Logger;
    /**
     * Absolute host path of the project's `data/` directory.
     *
     * Plugins that need to persist host-side state (auth tokens that
     * must not cross into the container, on-disk caches, etc.) should
     * scope their files under `<dataDir>/<plugin-id>/...` to avoid
     * collisions. Anything that needs to be visible to the agent or to
     * other plugins should go through the bus or workspace instead —
     * `dataDir` is for plugin-private host-only state.
     */
    readonly dataDir: string;
    /**
     * Absolute host path of the project's `tmp/` directory — the
     * gitignored, safe-to-wipe scratch root (it also holds the daemon
     * pidfile, the postgres port file, and per-event scratch dirs).
     *
     * Use this for ephemeral on-disk caches that can be regenerated at
     * any time (e.g. a refetchable model catalogue). Plugin-private
     * state that must survive a `tmp/` wipe belongs under
     * {@link dataDir} instead.
     */
    readonly tmpDir: string;
    /**
     * Cheap synchronous probe for whether the host daemon (`./cli.sh
     * start`) is currently running on this machine. Inspects the
     * daemon's pidfile under `<tmpDir>/.daemon.pid` and confirms the
     * recorded pid is still alive — no network calls, no MCP traffic.
     *
     * One-shot CLI commands that need to reach MCPs (i.e. anything
     * routed through `ctx.mcp`) should call this up front and exit
     * early when it returns `false`: the bastion that fronts MCPs
     * lives inside the daemon, so attempting an MCP call without it
     * fails with a generic `fetch failed` that misleads users into
     * chasing login state instead of the missing daemon.
     */
    readonly isDaemonRunning: () => boolean;
    /**
     * Read/write access to the host's YAML config (`config/config.yml`).
     *
     * Plugins read their own subtree (e.g. `telegram.botToken`) via
     * `ctx.config.getString(...)` rather than touching `process.env`
     * or parsing the file themselves. Required-vs-optional is decided
     * per call: omit the default to throw on missing, or pass `null`
     * to get a `string | null` back and self-disable on absence.
     */
    readonly config: ConfigService;
    /**
     * Inference-provider resolution. Lets a host-side plugin turn a
     * provider key (as configured under `inference.apiKeys.<key>`) into
     * the concrete `{ apiKey, npmPackage, apiEndpoint? }` it needs to
     * talk to the provider directly — without re-implementing the
     * models.dev + plugin-descriptor lookup the platform already owns.
     *
     * The motivating consumer is the memory plugin, which builds an
     * embedding client against the real upstream (it does not go through
     * the bastion). `resolveProvider` resolves `npmPackage` / `apiEndpoint`
     * from the models.dev catalogue or a plugin's
     * {@link PluginHostManifest.getModelProviders} descriptor, and reads
     * `apiKey` from config. Returns `undefined` when the key isn't
     * configured or doesn't resolve to a known provider.
     */
    readonly inference: {
        resolveProvider(
            key: string,
        ): Promise<{ apiKey: string; npmPackage: string; apiEndpoint?: string } | undefined>;
    };
    /**
     * Access to MCPs declared in `config/mcp.yml`. `getList()` returns
     * metadata only (no connections opened). The two getters return the
     * official `@modelcontextprotocol/sdk` `Client` ready to use —
     * `client.callTool({ name, arguments })`, `client.listTools()`, etc.
     *
     * Connections are lazy and cached: returning a client from
     * `getByKey` does not open one; the first method invocation on the
     * client opens a connection to the bastion's MCP gateway and that
     * connection is reused thereafter. The host closes every cached
     * client on daemon shutdown.
     *
     * First-call latency note: stdio-transport MCPs (npm / pypi /
     * docker-mcp-registry) are cold-spawned on the bastion's first
     * request and idle-reaped after `idleTimeoutSeconds` (per-entry in
     * `mcp.yml`, default 30 min). The first `callTool` / `listTools`
     * after the daemon starts can therefore take seconds; subsequent
     * calls within the idle window are milliseconds.
     */
    /**
     * Shared calendar data layer. Plugins that act as calendar
     * providers register a {@link CalendarProvider} during `start()`
     * via `ctx.calendar.registerProvider(provider)` and then feed the
     * cache through `upsertCalendar` / `addEvent`. Plugins that just
     * read calendars (notifications, summaries) use the read side
     * (`findEvents`, `getEvent`, `resolveDefaultCalendar`). The core
     * `cal_*` agent tools dispatch through the same interface.
     */
    readonly calendar: CalendarApi;
    /**
     * Shared mail dispatch layer. Plugins that act as mail providers
     * register a {@link MailProvider} during `start()` via
     * `ctx.mail.registerProvider(provider)`. The core `mail_*` agent
     * tools route through the registered provider by parsing the
     * `<pluginId>:` prefix on every mail id.
     *
     * Unlike `calendar`, there is no read-side surface here — the
     * core does not cache mail bodies or metadata. Pollers emit
     * `mail:<plugin>` events with a prefixed `mail_id` in the payload;
     * the agent reaches the body via `mail_fetch_body` on demand.
     */
    readonly mail: MailApi;
    /**
     * Read the per-mailbox style template the user (or the
     * extract-style handler) wrote at `data/mail/templates/<mailbox>/<name>.json`.
     * Used by mail provider implementations at send time to inject the
     * user's signature + CSS into outgoing mail. Returns `undefined`
     * when no template exists yet for the (mailbox, name) pair — the
     * caller should fall back to sending bare HTML.
     *
     * `name` defaults to `"default"`. Writes flow through the core
     * `mailstyle_*` agent tools, not directly through this surface —
     * `ctx` exposes only the read path because that's what plugins
     * (mail providers) need.
     */
    readonly getMailStyleTemplate: (
        mailbox: string,
        name?: string,
    ) => Promise<MailStyleTemplate | undefined>;
    /**
     * Observe markdown files in the workspace. The snapshot-then-diff
     * pattern: `ctx.workspace.listMarkdownFiles(filter)` for the
     * baseline, `ctx.workspace.onMarkdownFileUpdate(filter, cb)` for
     * live transitions (added / changed / removed under the filter
     * matched against frontmatter and/or workspace-relative path). See
     * {@link WorkspaceWatcherApi} for the full contract.
     *
     * Only available inside the daemon: one-shot CLI invocations
     * (`./cli.sh <plugin> …`) do not spin up the watcher, so calling
     * either method from a CLI command throws synchronously. Daemon
     * plugins are the intended consumer.
     */
    readonly workspace: WorkspaceWatcherApi;
    readonly mcp: {
        /**
         * Snapshot of every MCP declared in `mcp.yml` as `{ key, source,
         * package }`. Does not open any connections.
         */
        getList(): readonly McpInfo[];
        /**
         * Return the MCP SDK client for the entry with this yml key.
         * Throws if the key is unknown. The returned client opens its
         * connection lazily on its first method call.
         */
        getByKey(key: string): Client;
        /**
         * Return the MCP SDK client whose combined `package` field
         * (image / package / url, per source) exactly matches `pkg`.
         * The optional `source` arg narrows the search first. Throws
         * if zero or multiple entries match.
         */
        getByPackage(pkg: string, source?: string): Client;
    };
    /**
     * Aborts when the host daemon is no longer running — i.e. when the
     * `./cli.sh start` process backing this context has stopped or
     * crashed. Always present; consumers don't need to null-check.
     *
     * Intended use: one-shot CLI commands (`./cli.sh <plugin> ...`,
     * `./cli.sh cli-chat`, etc.) race long waits (`emit().settled`,
     * polling loops, interactive prompts) against this signal and exit
     * cleanly when it fires instead of hanging on a postgres connection
     * the dying daemon took with it.
     *
     * For daemon-internal contexts (cron, scheduled handlers, plugin
     * `start`/tool contexts that live inside the daemon process itself)
     * this signal never fires under normal operation — there is no
     * "other daemon" to watch; the daemon owns its own shutdown.
     *
     * When fired by the CLI-side watcher, the abort reason is the
     * string `"daemon-stopped"`. Consumers that need to distinguish
     * daemon-down from other aborts can check {@link DaemonStoppedError}
     * on rejected promises from `ctx.events.emit().settled`.
     */
    readonly daemonDownSignal: AbortSignal;
}

/**
 * Thrown by `ctx.events.emit().settled` when the host daemon stops
 * (or crashes) while a one-shot CLI command was waiting for the event
 * to reach a terminal state. Catch and exit cleanly — there is no
 * postgres on the other side to recover state from.
 */
export class DaemonStoppedError extends Error {
    constructor(message = "Host daemon stopped") {
        super(message);
        this.name = "DaemonStoppedError";
    }
}

/**
 * One tool a plugin contributes to the agent. The agent reaches it
 * via the bastion's `/plugin-tools/` gateway: the container fetches
 * the catalog (name, description, schema), and any tool call routes
 * back to the host where {@link execute} runs **inside the plugin's
 * own Node process** with access to the plugin's deps.
 *
 * Naming: `name` is the bare tool name (e.g. `draft_response`); the
 * gateway registers it under `${pluginId}_${name}` so a handler's
 * `tools:` can address each plugin's tools as a group. Keep `name`
 * lowercase alnum + `_` to avoid the sanitization fold the gateway
 * applies on the key.
 *
 * `inputSchema` is raw JSON Schema — the same shape MCP tools return
 * from `listTools()`. The container converts it via the AI SDK's
 * `jsonSchema()` helper before handing the tool to the model.
 *
 * Result is returned to the agent **unwrapped**: whatever {@link
 * execute} resolves with goes straight back to the model. The
 * `{ ok, result | error }` envelope on the wire is purely the
 * HTTP-layer error channel; agent-facing semantics match how MCP
 * tools and the built-in subagent tools (`schedule_handler`,
 * `call_handler`) feel.
 */
export interface PluginTool<TInput = unknown, TOutput = unknown> {
    /**
     * Bare tool name (no plugin prefix). The gateway namespaces it as
     * `${pluginId}_${name}` for registration, so this stays short and
     * action-oriented.
     */
    readonly name: string;
    /** Plain-English description the model sees on its tool list. */
    readonly description: string;
    /** Raw JSON Schema describing the `execute` args. */
    readonly inputSchema: object;
    /**
     * Run the tool. Receives the parsed args and the call context the
     * gateway resolves per invocation (full event + agentrun rows,
     * plugin-scoped HostContext, scoped logger). Throw or reject to
     * surface a tool error to the agent.
     */
    execute(args: TInput, ctx: PluginToolCallContext): Promise<TOutput>;
    /**
     * Curated tool groups this tool joins, in addition to its
     * identity-derived auto-group (the plugin id). Every name in the
     * array becomes a group that resolves to a union of every tool
     * declaring it — built-in container tools, host-side core tools,
     * and plugin tools all contribute through the same mechanism.
     *
     * Conventional names today:
     *
     * - `core` — the implicit default tool set every handler that
     *   omits `tools:` receives. Reserve this for genuinely ambient
     *   capabilities (long-term memory, basic chat reply, file read)
     *   whose `description` reads cleanly out of any context.
     * - `fs`, `reflection`, … — curated bundles a handler opts into
     *   via `tools: fs` or `tools: core, reflection`. New names can
     *   be coined freely.
     *
     * Each name must match {@link IDENT_PATTERN} and must not be one
     * of the three reserved names (`all`, `none`, `mcp`). A
     * plugin tool cannot list its own plugin id (the auto-group
     * already covers that). Registration fails loudly on either
     * violation.
     */
    readonly groups?: readonly string[];
    /**
     * Security classification gating who may invoke this tool. Omitted
     * ⇒ {@link DEFAULT_TOOL_LEVEL} (`default`, anyone). Set `approval`
     * for external mutations (sending mail, …) and `privileged` for
     * capabilities restricted to trusted-input runs. Enforced
     * container-side in `ToolsFactory`. See {@link ToolLevel}.
     */
    readonly level?: ToolLevel;
}

/**
 * Per-invocation context the host gateway resolves for every plugin
 * tool call. The container POSTs `{ args, eventId, agentrunId }`; the
 * gateway loads the full rows and the plugin's scoped {@link
 * HostContext} before calling {@link PluginTool.execute}.
 */
export interface PluginToolCallContext {
    /**
     * The originating event row. Tools dig into `payload` here for
     * the entity they're acting on (e.g. mail id for `draft_response`).
     */
    readonly event: EventRow;
    /** The agentrun row that issued the tool call. */
    readonly agentrun: AgentRunRow;
    /**
     * The plugin's own {@link HostContext} — same instance the
     * plugin's `start`/`tools` saw. Lets the tool emit follow-up
     * events, reach MCPs, read config, etc.
     */
    readonly host: HostContext;
    /** Logger child pre-scoped to `{ plugin, tool, eventId, agentrunId }`. */
    readonly log: Logger;
    /**
     * Per-call runner context: byte budget plus a `spill` callback that
     * writes oversized results into the calling event's scratch dir.
     * Pass this into {@link import("./ToolRunner.js").runJsonTool} (or
     * its `JsonLines`/`Text` siblings) so the runner can decide between
     * inline and offload-to-scratch consistently across host and
     * container.
     */
    readonly toolRunContext: ToolRunContext;
}

/**
 * Host-side surface a plugin may declare. All fields optional; a
 * plugin that's pure workspace template (no host code) leaves `host`
 * out of its manifest entirely.
 *
 * Each function receives the {@link HostContext} so handlers close
 * over `ctx` and never need to look up host services another way.
 */
export interface PluginHostManifest {
    /**
     * Synchronous, side-effect-light setup. Runs once per process,
     * **before any plugin's `start`** and before any plugin one-shot
     * CLI command's `run`. Use this for module-level state that other
     * plugins consume — e.g. populating an API-key constant the
     * plugin's library exports — so the order in which siblings call
     * each other doesn't depend on `start` finishing first.
     *
     * Hard rules: no async, no network, no DB, no daemons, no
     * subscriptions. If you need any of those, do them in `start`.
     *
     * Skipped for introspective paths (`--help`, `config lint`) so a
     * misconfigured file still lets the user inspect / lint.
     */
    prepare?(ctx: HostContext): void;
    /**
     * Long-running daemon (sockets, listeners, etc.). Awaited at host
     * startup; should resolve once setup is done. Long-lived work
     * lives on background promises the daemon owns.
     *
     * Runs after every plugin's {@link prepare} has completed, so
     * cross-plugin module state populated in `prepare` is reliably
     * visible by the time any `start` body runs.
     */
    start?(ctx: HostContext): Promise<void>;
    /**
     * Drain hook called during daemon shutdown. Awaited in reverse
     * registration order (LIFO of `start`), wrapped in a `safeStop`
     * so a throw is logged but does not abort the rest of the drain.
     *
     * Use this for plugins that own dirty in-memory state which must
     * be flushed to disk before the process exits — the memory
     * plugin's Orama index is the motivating case.
     *
     * Hard rules: must resolve within the daemon-wide drain budget
     * (see `DRAINING_DEADLINE_MS` in `host/src/commands/Start.ts`).
     * The shared budget covers every plugin's stop plus the postgres
     * + bastion teardown, so individual stops should keep their work
     * tight — a single bad flush should not eat the whole budget.
     *
     * Not called for one-shot CLI command runs — only on daemon
     * shutdown via `PluginHost.close()`.
     */
    stop?(ctx: HostContext): Promise<void>;
    /**
     * Declarative list of {@link PluginTool}s this plugin contributes
     * to the agent. Collected once, **after** the plugin's `start`
     * resolves, so closures over `start`-time state are safe.
     *
     * Hard rules: synchronous, side-effect-free — just build and
     * return the tool list. The host registers each tool under
     * `${plugin.id}_${tool.name}` (after sanitization) on the bastion's
     * `/plugin-tools/` gateway, and the container's tools client
     * discovers them per agentrun.
     *
     * A plugin id used for tools must match {@link IDENT_PATTERN} and
     * not collide with an MCP id — the registry enforces both at
     * register time so the failure surfaces at startup, not at first
     * call.
     */
    tools?(ctx: HostContext): readonly PluginTool[];
    /**
     * Supply {@link ModelMetaData} for a model the default (models.dev)
     * database does not cover. The host calls this on every plugin that
     * declares it — in registration order — only when a `(provider,
     * model)` lookup misses the built-in database, and takes the first
     * non-`undefined` result.
     *
     * - Return `undefined` to defer (this plugin doesn't know the model,
     *   or its own data isn't ready yet).
     * - Throw {@link ModelNotSupported} when the plugin authoritatively
     *   owns `provider` and knows `model` is not supported there — the
     *   host treats that as a definitive "no" and stops the lookup
     *   without consulting further plugins.
     *
     * Other thrown errors are logged and the lookup continues with the
     * next plugin, so a transient read failure doesn't poison results
     * another plugin could still provide.
     */
    getModelMetaData?(
        ctx: HostContext,
        provider: string,
        model: string,
    ): Promise<ModelMetaData | undefined>;
    /**
     * Declare the inference provider(s) this plugin owns — providers the
     * models.dev database doesn't cover (e.g. `featherless`). Returned
     * synchronously from constants (no fetch); the host calls it during
     * provider resolution to learn the provider's `npmPackage` (which
     * `create*` to use, how to inject auth) and `apiEndpoint` (where the
     * reverse proxy forwards). The declared `key` is what the operator
     * puts under `inference.apiKeys.<key>`.
     *
     * On a key collision with models.dev, the models.dev entry wins; on a
     * collision between two plugins, the first registered wins (logged).
     */
    getModelProviders?(ctx: HostContext): readonly ModelProviderDescriptor[];
    /**
     * Default command for the plugin's CLI root. When set, invoking
     * the plugin id with no subcommand (e.g. `cli.sh cli-chat`) runs
     * this command's `run`. Its `args` are also lifted onto the root.
     * Useful for plugins whose primary mode is interactive (REPL-like)
     * — the user shouldn't have to remember a subcommand name.
     *
     * Subcommands declared in {@link commands} are still available
     * under the same root, so `cli.sh cli-chat send "hi"` keeps
     * working alongside the bare-root invocation.
     */
    main?(ctx: HostContext): AnyCommandDef;
    /**
     * Citty commands contributed by this plugin. They are mounted
     * under `subCommands[<plugin.id>]` in the root CLI by default
     * (e.g. `cli.sh cli-chat send "hi"`).
     */
    commands?(ctx: HostContext): readonly AnyCommandDef[];
}

/**
 * The full plugin manifest shape returned by {@link definePlugin}.
 *
 * A minimal plugin needs only `id`. Any combination of `host` and
 * `workspaceTemplate` may be added — they are independent concerns.
 * Plugin code never ships into the container: tools the agent can
 * call are declared on {@link PluginHostManifest.tools} and execute
 * host-side inside the plugin's own Node process via the bastion.
 */
export interface PluginManifest {
    /**
     * Plugin id, matching `[a-z0-9-]+`. Used to namespace the
     * plugin's CLI commands (`cli.sh <id> <subcommand>`). A plugin
     * that contributes {@link PluginHostManifest.tools | tools} must
     * additionally satisfy {@link IDENT_PATTERN} so the id is usable
     * as a tool group name; the tools registry enforces that at
     * register time.
     */
    readonly id: string;
    /** Host-side surface (CLI commands, daemons, cronjobs, tools). */
    readonly host?: PluginHostManifest;
    /**
     * Absolute path to a directory of files copied into
     * `data/workspace/` on first install. Existing files are left
     * alone — diff/merge on plugin updates is a separate concern.
     * Plugins typically derive this with
     * `path.join(__dirname, "..", "workspace-template")` (or the ESM
     * `import.meta.url` equivalent).
     */
    readonly workspaceTemplate?: string;
}

/**
 * Identity function used by plugins to declare their manifest:
 *
 * ```ts
 * export default definePlugin({
 *   id: "cli-chat",
 *   host: { commands: (ctx) => [sendCommand(ctx)] },
 * });
 * ```
 *
 * Exists purely so TypeScript narrows literal types correctly without
 * the caller writing a `satisfies PluginManifest` clause. Same pattern
 * as Vite's `defineConfig` / Astro's `defineConfig`.
 */
export function definePlugin<T extends PluginManifest>(plugin: T): T {
    return plugin;
}
