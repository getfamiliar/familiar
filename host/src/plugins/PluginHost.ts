import { cpSync, existsSync } from "node:fs";
import type {
    AnyCommandDef,
    ConfigService,
    HostContext,
    Logger,
    ModelMetaData,
    ModelProviderDescriptor,
    PostgresConnection,
} from "@getfamiliar/shared";
import { EventBus, ModelNotSupported } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import type { Bootstrap } from "../Bootstrap.js";
import { CalendarRegistry } from "../calendar/CalendarRegistry.js";
import { CalendarSafety } from "../calendar/CalendarSafety.js";
import { CalendarService } from "../calendar/CalendarService.js";
import { CalendarStore } from "../calendar/CalendarStore.js";
import { buildCalendarTools } from "../calendar/CalendarTools.js";
import { inspectPidFile } from "../commands/pidfile.js";
import { HostConfigService } from "../config/ConfigService.js";
import { ContainerToolsRegistry } from "../container-tools/ContainerToolsRegistry.js";
import { PostgresContainer } from "../db/PostgresContainer.js";
import { MailRegistry } from "../mail/MailRegistry.js";
import { MailSafety } from "../mail/MailSafety.js";
import { MailStyleStore } from "../mail/MailStyleStore.js";
import { buildMailStyleTools } from "../mail/MailStyleTools.js";
import { buildMailTools } from "../mail/MailTools.js";
import { McpRegistry } from "../mcp/McpRegistry.js";
import { PluginMcpService } from "../mcp/PluginMcpService.js";
import { ModelMetadataService } from "../models/ModelMetadataService.js";
import type { ResolvedProvider } from "../models/ProviderResolution.js";
import { buildReflectionTools } from "../reflection/ReflectionTools.js";
import type { WorkspaceWatcher } from "../workspace/WorkspaceWatcher.js";
import { EventContextRegistry } from "./EventContextRegistry.js";
import { HostContextImpl } from "./HostContextImpl.js";
import { plugins } from "./Registry.js";
import type { PluginToolsRegistry } from "./ToolsRegistry.js";

/**
 * Poll cadence for the daemon-pidfile watcher in CLI mode. Has to be
 * tight enough that a user pressing `./cli.sh stop` in another
 * terminal sees their long-running CLI ({@link plugins/cli-chat})
 * exit cleanly within a beat, and slack enough that the
 * `inspectPidFile` syscall isn't a hot loop. 500 ms picks the middle.
 */
const DAEMON_PIDFILE_POLL_MS = 500;

/**
 * Fallback bastion loopback URL used by {@link PluginHost} when no
 * URL is set (e.g. one-shot CLI commands that hit MCPs without a
 * running daemon — connections still fail with `ECONNREFUSED` in
 * that case, which is the right behavior). Matches the bastion's
 * own default port; daemon mode overrides via
 * {@link PluginHost.setBastionBaseUrl}.
 */
const DEFAULT_BASTION_BASE_URL = "http://127.0.0.1:8788";

/**
 * Loader and lifecycle owner for plugins inside the host process.
 *
 * One instance per CLI invocation. Lazily opens a postgres connection
 * on the first plugin call that needs it (e.g. `ctx.events.emit`), so
 * `--help` and other introspective paths stay free of side effects.
 *
 * Plugin commands are wrapped at registration time with a try/finally
 * that closes the connection after `run()` returns. Without this, a
 * one-shot CLI command would hang on the still-open postgres pool.
 */
export class PluginHost {
    private readonly boot: Bootstrap;
    private readonly log: Logger;
    private readonly config: ConfigService;
    private readonly mcpRegistry: McpRegistry;
    private readonly mcpService: PluginMcpService;
    private readonly calendarService: CalendarService;
    private readonly calendarSafety: CalendarSafety;
    private readonly mailRegistry: MailRegistry;
    private readonly mailSafety: MailSafety;
    private readonly mailStyleStore: MailStyleStore;
    private readonly eventContextRegistry: EventContextRegistry;
    private readonly modelMetadataService: ModelMetadataService;
    private toolsRegistry: PluginToolsRegistry | undefined;
    private containerToolsRegistry: ContainerToolsRegistry | undefined;
    private workspaceWatcher: WorkspaceWatcher | undefined;
    private bastionBaseUrl: string = DEFAULT_BASTION_BASE_URL;
    private connection: PostgresConnection | undefined;
    private prepared = false;
    /**
     * One controller shared by every plugin {@link HostContext} built
     * by this PluginHost. {@link wrapForExit} arms it from the pidfile
     * watcher in CLI mode; daemon mode never fires it (the daemon owns
     * its own shutdown). Process-scoped: once aborted, stays aborted —
     * matches "daemon went down" semantics.
     */
    private readonly daemonDownController = new AbortController();

    constructor(boot: Bootstrap, log: Logger, config?: ConfigService, mcpRegistry?: McpRegistry) {
        this.boot = boot;
        this.log = log;
        this.config = config ?? new HostConfigService(boot.configFile);
        this.mcpRegistry = mcpRegistry ?? new McpRegistry(boot.mcpConfigFile, log);
        this.mcpService = new PluginMcpService({
            registry: this.mcpRegistry,
            bastionBaseUrl: this.bastionBaseUrl,
            log: log.child({ component: "plugin-mcp" }),
        });
        const calendarStore = new CalendarStore(() => this.ensureConnection());
        this.calendarService = new CalendarService({
            store: calendarStore,
            registry: new CalendarRegistry(),
            events: async () => new EventBus(await this.ensureConnection()),
            config: this.config,
            log: log.child({ component: "calendar" }),
        });
        this.calendarSafety = new CalendarSafety(this.config);
        this.mailRegistry = new MailRegistry();
        this.mailSafety = new MailSafety(this.config);
        this.mailStyleStore = new MailStyleStore(boot.dataDir, (msg) =>
            log.child({ component: "mail-style" }).warn(msg),
        );
        this.eventContextRegistry = new EventContextRegistry();
        this.modelMetadataService = new ModelMetadataService({
            tmpDir: boot.tmpDir,
            lookupPluginMeta: (provider, model) => this.lookupModelMetaData(provider, model),
            listPluginProviders: () => this.listModelProviders(),
            log: log.child({ component: "model-metadata" }),
        });
    }

    /**
     * The shared {@link ModelMetadataService} (models.dev cache + plugin
     * fallback). Owned here so provider resolution works in both daemon
     * and one-shot CLI contexts; `Start.ts` reads it off this getter to
     * wire the bastion gateway + the daily refresh cron.
     */
    get modelMetadata(): ModelMetadataService {
        return this.modelMetadataService;
    }

    /**
     * Collect the inference-provider descriptors every plugin declares
     * via {@link import("@getfamiliar/shared").PluginHostManifest.getModelProviders},
     * in registration order. Duplicate keys are dropped (first plugin
     * wins, logged). Backs both provider-level metadata resolution and
     * the linter's known-provider check.
     */
    listModelProviders(): ModelProviderDescriptor[] {
        const out: ModelProviderDescriptor[] = [];
        const seen = new Set<string>();
        for (const plugin of plugins) {
            const hook = plugin.host?.getModelProviders;
            if (!hook) {
                continue;
            }
            let descriptors: readonly ModelProviderDescriptor[];
            try {
                descriptors = hook(this.context(plugin.id));
            } catch (err) {
                this.log.warn(
                    { plugin: plugin.id, err: err instanceof Error ? err.message : String(err) },
                    `plugin "${plugin.id}" getModelProviders threw`,
                );
                continue;
            }
            for (const descriptor of descriptors) {
                if (seen.has(descriptor.key)) {
                    this.log.warn(
                        { plugin: plugin.id, key: descriptor.key },
                        `duplicate model provider key "${descriptor.key}" from plugin "${plugin.id}" — ignored`,
                    );
                    continue;
                }
                seen.add(descriptor.key);
                out.push(descriptor);
            }
        }
        return out;
    }

    /**
     * Resolve a configured provider key into the concrete
     * {@link ResolvedProvider} the reverse proxy and container need:
     * its api key (from `inference.apiKeys.<key>`) joined with the
     * provider-level metadata (`npmPackage` / `apiEndpoint`) from
     * models.dev or a plugin descriptor.
     *
     * Returns `undefined` when the key has no api key configured or
     * doesn't resolve to a known provider — callers (startup validation)
     * turn that into a clear error; `ctx.inference.resolveProvider`
     * forwards it to plugins as a soft miss.
     *
     * @param key Provider key as used under `inference.apiKeys.<key>`.
     */
    async resolveProvider(key: string): Promise<ResolvedProvider | undefined> {
        const apiKey = this.config.getString(`inference.apiKeys.${key}`, null);
        if (apiKey === null || apiKey.length === 0) {
            return undefined;
        }
        const meta = await this.modelMetadataService.lookupProvider(key);
        if (meta?.npmPackage === undefined) {
            return undefined;
        }
        return { key, apiKey, npmPackage: meta.npmPackage, apiEndpoint: meta.apiEndpoint };
    }

    /**
     * The shared event-context registry backing every plugin's
     * `ctx.events.registerContextProvider`. Exposed so the bastion's
     * {@link import("../bastion/EventContextGateway.js").EventContextGateway}
     * can read the live list of registered providers and fan calls
     * out in parallel.
     */
    get eventContext(): EventContextRegistry {
        return this.eventContextRegistry;
    }

    /**
     * Ask every plugin that declares a
     * {@link import("@getfamiliar/shared").PluginHostManifest.getModelMetaData}
     * hook for metadata about a `(provider, model)` pair, in
     * registration order. Returns the first non-`undefined` result.
     *
     * A plugin throwing {@link ModelNotSupported} is authoritative: it
     * owns the provider and knows the model isn't supported there, so
     * the lookup stops and returns `undefined` without consulting the
     * remaining plugins. Any other thrown error is logged and the loop
     * continues, so a transient read failure in one plugin doesn't mask
     * an answer another could provide.
     *
     * Used by the host's
     * {@link import("../models/ModelMetadataService.js").ModelMetadataService}
     * as the fallback path when the built-in models.dev database doesn't
     * cover a model (e.g. featherless ids).
     *
     * @param provider Resolved provider id (e.g. `featherless`).
     * @param model Resolved model id (e.g. `zai-org/GLM-5.1`).
     * @returns The first plugin-supplied {@link ModelMetaData}, or
     *   `undefined` when no plugin knows the model.
     */
    async lookupModelMetaData(provider: string, model: string): Promise<ModelMetaData | undefined> {
        for (const plugin of plugins) {
            const hook = plugin.host?.getModelMetaData;
            if (!hook) {
                continue;
            }
            try {
                const meta = await hook(this.context(plugin.id), provider, model);
                if (meta !== undefined) {
                    return meta;
                }
            } catch (err) {
                if (err instanceof ModelNotSupported) {
                    return undefined;
                }
                this.log.warn(
                    {
                        plugin: plugin.id,
                        provider,
                        model,
                        err: err instanceof Error ? err.message : String(err),
                    },
                    `plugin "${plugin.id}" getModelMetaData threw for ${provider}/${model}`,
                );
            }
        }
        return undefined;
    }

    /**
     * Wire the plugin-tools registry that {@link startDaemons} will
     * populate from each plugin's `tools(ctx)` hook. Optional — when
     * unset (one-shot CLI commands that never run plugin daemons),
     * `tools(ctx)` hooks are skipped silently.
     */
    setToolsRegistry(registry: PluginToolsRegistry): void {
        this.toolsRegistry = registry;
    }

    /**
     * Wire the registry the agent container reports its built-in tool
     * catalog into. Read by the `tool_list` reflection tool so it can
     * enumerate container built-ins without a hand-maintained copy.
     * Optional — when unset, `tool_list` simply shows no built-ins.
     */
    setContainerToolsRegistry(registry: ContainerToolsRegistry): void {
        this.containerToolsRegistry = registry;
    }

    /**
     * Wire the shared workspace watcher that backs `ctx.workspace` for
     * every plugin context this host builds. Daemon mode calls this after
     * `WorkspaceWatcher.start()` resolves and before `startDaemons()` so
     * plugins can call `ctx.workspace.onMarkdownFileUpdate(...)` (or
     * `listMarkdownFiles`) from inside `start(ctx)`. One-shot CLI
     * invocations leave it unset; calling either method from a CLI
     * command throws.
     */
    setWorkspaceWatcher(watcher: WorkspaceWatcher): void {
        this.workspaceWatcher = watcher;
    }

    /**
     * Override the loopback URL plugin MCP calls dial. Daemon mode
     * calls this after {@link Bastion.start} resolves so plugin MCP
     * calls hit the live port, even if the operator configured a
     * non-default bastion port. Calling before any client connects
     * keeps the indirection cost at zero.
     *
     * One-shot CLI commands that never touch `ctx.mcp` simply use
     * the default; if they do touch it without a running daemon,
     * the connect fails with `ECONNREFUSED` — the correct outcome.
     */
    setBastionBaseUrl(url: string): void {
        this.bastionBaseUrl = url;
        this.mcpService.setBastionBaseUrl(url);
    }

    /**
     * The shared MCP service backing every plugin's `ctx.mcp`. Exposed
     * so daemon-owned host services (cron scheduler, future approval
     * gate) can build their own {@link HostContextImpl} pointing at
     * the same singleton instead of opening a parallel client pool.
     */
    get mcp(): PluginMcpService {
        return this.mcpService;
    }

    /**
     * The shared calendar service backing every plugin's
     * `ctx.calendar`. Exposed so daemon-owned host services that build
     * their own {@link HostContextImpl} (cron scheduler, etc.) can
     * reach the same registry and DB layer the plugins already use.
     */
    get calendar(): CalendarService {
        return this.calendarService;
    }

    /**
     * The shared mail registry backing every plugin's `ctx.mail`.
     * Exposed for the same reason as {@link calendar} — daemon-owned
     * host services that build their own context can dispatch to the
     * already-registered providers without re-instantiating.
     */
    get mail(): MailRegistry {
        return this.mailRegistry;
    }

    /**
     * The shared mail-style-template store. Backs `ctx.getMailStyleTemplate`
     * (plugin read path) and the core `mailstyle_*` agent tools (write path).
     * Exposed for the same reason as {@link mail}.
     */
    get mailStyle(): MailStyleStore {
        return this.mailStyleStore;
    }

    /**
     * Build the citty `subCommands` map contributed by all plugins.
     * Each plugin's commands are nested under `subCommands[plugin.id]`,
     * so users invoke them as `cli.sh <plugin-id> <subcommand>`.
     *
     * @throws If two plugins declare the same id, or if a plugin
     *   command is missing `meta.name`.
     */
    buildSubCommands(): Record<string, AnyCommandDef> {
        const map: Record<string, AnyCommandDef> = {};
        for (const plugin of plugins) {
            if (map[plugin.id]) {
                throw new Error(`Duplicate plugin id: ${plugin.id}`);
            }
            const host = plugin.host;
            if (!host?.commands && !host?.main) {
                continue;
            }
            const ctx = this.context(plugin.id);
            const subCmds = host.commands?.(ctx).map((cmd) => this.wrapForExit(cmd)) ?? [];
            const main = host.main ? this.wrapForExit(host.main(ctx)) : undefined;
            map[plugin.id] = pluginRoot(plugin.id, subCmds, main);
        }
        return map;
    }

    /**
     * Seed the workspace from templates. Two layers, copied in this
     * order so the first writer wins on overlaps (`force: false`):
     *
     *   1. Global template at `data/workspace-template/` — versioned
     *      with the repo, authored by the user. Authoritative for
     *      anything it ships (e.g. `SOUL.md`, `CONTEXT.md`).
     *   2. Plugin templates contributed via `plugin.workspaceTemplate`
     *      — fill in topic-specific defaults the global template
     *      didn't already cover.
     *
     * Idempotent and safe to call on every daemon start. Diff/merge on
     * plugin updates (when a plugin ships a newer default than the
     * user's local copy) is the open question already in CLAUDE.md and
     * is not handled here.
     */
    installWorkspaceTemplates(): void {
        if (existsSync(this.boot.workspaceTemplateDir)) {
            cpSync(this.boot.workspaceTemplateDir, this.boot.workspaceDir, {
                recursive: true,
                force: false,
                errorOnExist: false,
            });
        }
        for (const plugin of plugins) {
            if (!plugin.workspaceTemplate) {
                continue;
            }
            if (!existsSync(plugin.workspaceTemplate)) {
                continue;
            }
            cpSync(plugin.workspaceTemplate, this.boot.workspaceDir, {
                recursive: true,
                force: false,
                errorOnExist: false,
            });
        }
    }

    /**
     * Run every plugin's synchronous `prepare(ctx)` hook once per
     * process. Idempotent — repeated calls are no-ops, so individual
     * command entry points can call this without coordinating.
     *
     * Called automatically before any plugin one-shot command's
     * `run` (see {@link wrapForExit}) and explicitly by the daemon
     * `start` command before {@link startDaemons}. Not invoked from
     * introspective paths (`--help`, `config lint`) so a broken
     * config still lets the user inspect / lint.
     *
     * Plugin failures here propagate — `prepare` is supposed to be
     * trivial setup, so a throw means the plugin is misconfigured
     * and refusing to proceed is the right behavior.
     */
    prepareAll(): void {
        if (this.prepared) {
            return;
        }
        for (const plugin of plugins) {
            if (!plugin.host?.prepare) {
                continue;
            }
            plugin.host.prepare(this.context(plugin.id));
        }
        this.prepared = true;
    }

    /**
     * Await each plugin's `start(ctx)` hook in registration order.
     * Used during daemon boot. Failures bubble up — the daemon
     * refuses to start if any plugin daemon fails to initialize.
     *
     * Callers must invoke {@link prepareAll} first; daemon `start`
     * does this explicitly so cross-plugin module state populated in
     * `prepare` is reliably visible by the time any `start` body
     * runs.
     */
    async startDaemons(): Promise<void> {
        for (const plugin of plugins) {
            const host = plugin.host;
            if (!host?.start && !host?.tools) {
                continue;
            }
            const ctx = this.context(plugin.id);
            if (host?.start) {
                await host.start(ctx);
            }
            // `tools(ctx)` runs after `start()` resolves so closures
            // over start-time state are safe. Skipped when no
            // registry is wired (one-shot CLI paths).
            if (host?.tools && this.toolsRegistry) {
                const tools = host.tools(ctx);
                this.toolsRegistry.register(plugin.id, ctx, tools);
            }
        }
        // Core tools (`cal_*`, `mail_*`, future approval-gate prompts)
        // land after every plugin's `start` so any provider that
        // registered via `ctx.calendar.registerProvider` or
        // `ctx.mail.registerProvider` is reachable from the first tool
        // call. The reserved id `"core"` opts the registration into
        // the bare-key path (no plugin-id prefix) inside the registry.
        if (this.toolsRegistry) {
            const coreCtx = this.context("core");
            const coreTools = [
                ...buildCalendarTools(this.calendarService, {
                    scratchDir: this.boot.scratchDir,
                    safety: this.calendarSafety,
                }),
                ...buildMailTools({
                    registry: this.mailRegistry,
                    safety: this.mailSafety,
                }),
                ...buildMailStyleTools({ store: this.mailStyleStore }),
                // Reflection tools live alongside the other host-owned
                // core tools so they share the bare-key registration
                // path and join the `reflection` tool group with the
                // container-side `get_scheduled_handlers`.
                ...buildReflectionTools({
                    ensureConnection: () => this.ensureConnection(),
                    logsDir: this.boot.logsDir,
                    scratchDir: this.boot.scratchDir,
                    mcpRegistry: this.mcpRegistry,
                    pluginToolsRegistry: this.toolsRegistry,
                    containerToolsRegistry:
                        this.containerToolsRegistry ?? new ContainerToolsRegistry(),
                }),
            ];
            this.toolsRegistry.register("core", coreCtx, coreTools);
            const registered = this.toolsRegistry.list();
            if (registered.length > 0) {
                this.log.info(
                    `plugin tool registry: ${registered.length} tool${registered.length === 1 ? "" : "s"} — ${registered.map((t) => t.key).join(", ")}`,
                );
            }
        }
    }

    /**
     * Tear down host-side resources held by plugins:
     *  1. Each plugin's `stop(ctx)` hook, in reverse registration order
     *     (LIFO of `start`). Failures are logged and the drain
     *     continues — one bad plugin must not strand another's flush.
     *  2. Every cached MCP client.
     *  3. The shared postgres connection (if it was opened).
     *
     * MCP is closed after plugin stops because plugin `stop` hooks may
     * still want to log lifecycle lines, and the postgres-backed log
     * sink relays through host services that are alive at this point.
     */
    async close(): Promise<void> {
        for (let i = plugins.length - 1; i >= 0; i--) {
            const plugin = plugins[i];
            const stop = plugin?.host?.stop;
            if (!stop) {
                continue;
            }
            try {
                await stop(this.context(plugin.id));
            } catch (err) {
                this.log.error(
                    {
                        plugin: plugin.id,
                        err: err instanceof Error ? err.message : String(err),
                    },
                    "plugin stop hook threw",
                );
            }
        }
        await this.mcpService.close();
        if (!this.connection) {
            return;
        }
        const conn = this.connection;
        this.connection = undefined;
        await conn.close();
    }

    /**
     * Build the {@link HostContext} that every plugin lifecycle
     * method receives. The contract — what plugins are allowed to do
     * — lives in {@link HostContextImpl}, not in this class.
     */
    private context(pluginId: string): HostContext {
        return new HostContextImpl({
            pluginId,
            ensureConnection: () => this.ensureConnection(),
            config: this.config,
            log: this.log.child({ component: `plugin:${pluginId}` }),
            dataDir: this.boot.dataDir,
            tmpDir: this.boot.tmpDir,
            scratchDir: this.boot.scratchDir,
            pidFile: this.boot.pidFile,
            mcp: this.mcpService,
            calendar: this.calendarService,
            mail: this.mailRegistry,
            mailStyleStore: this.mailStyleStore,
            eventContextRegistry: this.eventContextRegistry,
            resolveProvider: (key) => this.resolveProvider(key),
            workspaceWatcher: this.workspaceWatcher,
            daemonDownSignal: this.daemonDownController.signal,
        });
    }

    /**
     * Open the postgres connection on demand. Reads
     * `core.postgresPassword` from the config service only when first
     * called, so commands that don't touch the bus don't trigger
     * config validation. Public so daemon-owned host services
     * (cron scheduler, future approval gate, etc.) can share the same
     * pool plugins already use.
     */
    async ensureConnection(): Promise<PostgresConnection> {
        if (this.connection) {
            return this.connection;
        }
        const password = this.config.getString("core.postgresPassword");
        const postgres = new PostgresContainer({
            dataPath: this.boot.dataDir,
            portFilePath: this.boot.postgresPortFile,
            password,
        });
        this.connection = postgres.getConnection();
        return this.connection;
    }

    /**
     * Wrap a plugin command's `run` so:
     *  - every plugin's `prepare(ctx)` fires once before the command
     *    body runs (matches the daemon-start invariant: any plugin
     *    can call into any other plugin's library without depending
     *    on `start` order);
     *  - the host's postgres connection is closed after the command
     *    returns. Without the close, the pool keeps the event loop
     *    alive and the CLI process hangs.
     */
    private wrapForExit(cmd: AnyCommandDef): AnyCommandDef {
        const original = cmd.run;
        if (!original) {
            return cmd;
        }
        return defineCommand({
            ...cmd,
            run: async (ctx) => {
                this.prepareAll();
                const stopWatcher = this.startDaemonPidfileWatcher();
                try {
                    return await (original as (c: typeof ctx) => unknown)(ctx);
                } finally {
                    stopWatcher();
                    await this.close();
                }
            },
        });
    }

    /**
     * Start a poller that aborts {@link daemonDownController} the
     * moment the daemon's pidfile becomes vacant/stale/malformed.
     * Returns a stop function the caller must invoke from `finally`.
     *
     * Used by {@link wrapForExit} so every plugin one-shot CLI command
     * gets `ctx.daemonDownSignal` wired to actual daemon liveness for
     * the duration of the invocation. Pure-CLI scenario: the daemon
     * isn't running at all when the command starts, so the very first
     * check aborts the signal — which is the correct behavior for
     * commands that needed the daemon (they observe `aborted`
     * synchronously on `ctx.daemonDownSignal`); commands that don't
     * care simply ignore the signal.
     *
     * The interval is `unref()`'d so it can't keep the event loop
     * alive past `original.run` returning — non-waiting one-shots
     * still exit promptly.
     */
    private startDaemonPidfileWatcher(): () => void {
        const check = () => {
            if (this.daemonDownController.signal.aborted) {
                return;
            }
            if (inspectPidFile(this.boot.pidFile).kind !== "alive") {
                this.daemonDownController.abort("daemon-stopped");
            }
        };
        check();
        const handle = setInterval(check, DAEMON_PIDFILE_POLL_MS);
        handle.unref();
        return () => {
            clearInterval(handle);
        };
    }
}

/**
 * Wrap a plugin's commands in a parent command keyed by the plugin's
 * id, so they appear under `cli.sh <plugin-id> ...` in the CLI tree.
 *
 * When `main` is provided, its `args` and `run` are lifted onto the
 * root so `cli.sh <plugin-id>` (no subcommand) executes that command
 * directly. Subcommands continue to work alongside it.
 */
function pluginRoot(
    id: string,
    cmds: readonly AnyCommandDef[],
    main?: AnyCommandDef,
): AnyCommandDef {
    const subCommands: Record<string, AnyCommandDef> = {};
    for (const cmd of cmds) {
        const meta = cmd.meta;
        if (!meta || typeof meta !== "object") {
            throw new Error(`Plugin "${id}" contributed a command with non-static meta`);
        }
        const name = (meta as { name?: string }).name;
        if (!name) {
            throw new Error(`Plugin "${id}" contributed a command without meta.name`);
        }
        if (subCommands[name]) {
            throw new Error(`Plugin "${id}" contributed two commands named "${name}"`);
        }
        subCommands[name] = cmd;
    }
    return defineCommand({
        meta: { name: id, description: `Commands provided by the ${id} plugin` },
        args: main?.args,
        run: main?.run,
        subCommands,
    });
}
