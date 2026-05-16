import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CommandDef } from "citty";
import type { AgentRunRow } from "./AgentRun.js";
import type { ChatFilter } from "./ChatMessage.js";
import type { ChatHandler, ChatUnsubscribe } from "./ChatMessageBus.js";
import type { ConfigService } from "./Config.js";
import type { EventFile, EventRow, NewEvent } from "./Event.js";
import type { Logger } from "./logging/Logger.js";
import type { StepResultRow } from "./StepResult.js";

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
     */
    readonly events: {
        emit(event: NewEvent, options?: EmitOptions): Promise<EmitHandle>;
    };
    /**
     * Chat capabilities. Currently exposes only `subscribe` — user
     * messages flow through the ordinary event pipeline (events with
     * `isChat=true`) so there is intentionally no parallel send API.
     *
     * Delivery is at-least-once: when no listener returned `true`
     * during a message's lifetime, a future subscriber matching the
     * filter will receive it on registration via the bus's replay
     * pass. Listeners must therefore tolerate being called for an
     * already-displayed message; the typical pattern is to render and
     * return `true` unconditionally.
     */
    readonly chat: {
        subscribe(filter: ChatFilter, handler: ChatHandler): Promise<ChatUnsubscribe>;
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
    /** Structured-ish log line. Future: scoped by plugin id, severity, etc. */
    readonly log: (message: string) => void;
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
     * Cheap synchronous probe for whether the host daemon (`./cli.sh
     * start`) is currently running on this machine. Inspects the
     * daemon's pidfile under `<dataDir>/.daemon.pid` and confirms the
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
}

/**
 * One tool a plugin contributes to the agent. The agent reaches it
 * via the bastion's `/plugin-tools/` gateway: the container fetches
 * the catalog (name, description, schema), and any tool call routes
 * back to the host where {@link execute} runs **inside the plugin's
 * own Node process** with access to the plugin's deps.
 *
 * Naming: `name` is the bare tool name (e.g. `draft_response`); the
 * gateway registers it under `${pluginId}_${name}` so the agent's
 * filter DSL can address each plugin's tools as a group. Keep `name`
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
 * tools and the built-in `queue_run` feel.
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
     * as a DSL group name; the tools registry enforces that at
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
