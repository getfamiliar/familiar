import { promises as fs } from "node:fs";
import path from "node:path";
import {
    AgentRunBus,
    type AgentRunUnsubscribe,
    type CalendarApi,
    type ChatFilter,
    type ChatHandler,
    ChatMessageBus,
    type ChatUnsubscribe,
    type ConfigService,
    DaemonStoppedError,
    type EmitHandle,
    type EmitOptions,
    EVENTS_STATE_CHANNEL,
    EventBus,
    type EventContextProvider,
    type EventFile,
    type EventRow,
    type HostContext,
    type Logger,
    type MailApi,
    type MailStyleTemplate,
    type McpClient,
    type McpInfo,
    type NewEvent,
    type NotificationHandler,
    type PostgresConnection,
    StepResultBus,
    type StepResultUnsubscribe,
    type WorkspaceFileEvent,
    type WorkspaceFileFilter,
    type WorkspaceWatcherApi,
} from "@getfamiliar/shared";
import { inspectPidFile } from "../commands/pidfile.js";
import type { MailStyleStore } from "../mail/MailStyleStore.js";
import type { PluginMcpService } from "../mcp/PluginMcpService.js";
import type { WorkspaceWatcher } from "../workspace/WorkspaceWatcher.js";
import type { EventContextRegistry } from "./EventContextRegistry.js";

/**
 * Dependencies a {@link HostContextImpl} needs from its owner. The
 * owner (typically {@link PluginHost}) owns the postgres connection's
 * lifecycle; the context only borrows it.
 */
export interface HostContextImplDeps {
    /**
     * Id of the plugin this context belongs to. Captured at construction
     * time so register-style surfaces that don't take an explicit id on
     * the wire (e.g. `events.registerContextProvider`) can stamp the
     * registering plugin onto the registry entry for logging and
     * fan-out attribution. `"core"` is reserved for daemon-internal
     * contexts (cron, future approval gate).
     */
    pluginId: string;
    /** Open (or return the already-open) shared postgres connection. */
    ensureConnection(): Promise<PostgresConnection>;
    /**
     * Shared host {@link ConfigService}, exposed to plugins as
     * `ctx.config`. Also used internally by `emit` to stamp the
     * default chat channel — kept on the same instance the plugins
     * see so a runtime `set()` from one consumer is observed by the
     * others.
     */
    config: ConfigService;
    /**
     * Per-plugin logger used by `ctx.log(...)`. The owner is expected
     * to scope this to the plugin (e.g. via `Logger.child`) before
     * handing it off so records carry a stable component tag.
     */
    log: Logger;
    /**
     * Absolute host path of the project's `data/` directory, surfaced
     * as `ctx.dataDir` to plugins. Sourced from the host {@link
     * Bootstrap} so there is one source of truth rather than a parallel
     * env var to drift out of sync.
     */
    dataDir: string;
    /**
     * Absolute host path of `tmp/scratch/`. Used internally by the
     * `events.emit` wrapper to stage `event.files` under
     * `<scratchDir>/<eventId>/` inside the INSERT transaction. Not
     * exposed on `HostContext`; plugins reach scratch only through
     * `emit({ files })`.
     */
    scratchDir: string;
    /**
     * Absolute path of the daemon's pidfile (`<tmpDir>/.daemon.pid`).
     * Used by `ctx.isDaemonRunning()` to decide whether the host
     * daemon is live without going through the bastion.
     */
    pidFile: string;
    /**
     * Shared singleton that backs `ctx.mcp`. One instance per host
     * process; each `HostContextImpl` just delegates. Owns the MCP
     * client cache and closes connections on host shutdown.
     */
    mcp: PluginMcpService;
    /**
     * Shared singleton that backs `ctx.calendar`. One instance per
     * host process — owns the provider registry and the postgres
     * accessors for the `calendars` + `calendar_events` tables.
     */
    calendar: CalendarApi;
    /**
     * Shared singleton that backs `ctx.mail`. One instance per host
     * process — owns the `pluginId → MailProvider` registry consumed
     * by the core `mail_*` tools. No DB layer (no mail cache).
     */
    mail: MailApi;
    /**
     * Shared per-mailbox style-template store. One instance per host
     * process. Backs both `ctx.getMailStyleTemplate` (plugin read path)
     * and the core `mailstyle_*` agent tools (write path).
     */
    mailStyleStore: MailStyleStore;
    /**
     * Shared registry backing `ctx.events.registerContextProvider`. One
     * instance per host process — owns the per-plugin function list
     * the bastion's `/event-context/` gateway fans out on every prompt
     * assembly.
     */
    eventContextRegistry: EventContextRegistry;
    /**
     * Shared workspace watcher backing `ctx.workspace`. Optional because
     * one-shot CLI invocations (`./cli.sh <plugin> …`) do not spin one
     * up; daemon contexts always pass it. When absent, every
     * `ctx.workspace.onFileUpdate` call throws synchronously.
     */
    workspaceWatcher?: WorkspaceWatcher;
    /**
     * Signal exposed to plugins as `ctx.daemonDownSignal`. CLI
     * invocations wire it to a pidfile watcher that aborts when the
     * daemon disappears; daemon-internal contexts pass a never-firing
     * signal. The context just forwards it — the watcher lives on
     * whoever constructs the context (typically
     * {@link import("./PluginHost.js").PluginHost.wrapForExit}).
     */
    daemonDownSignal: AbortSignal;
}

/**
 * Concrete {@link HostContext} used by the host process.
 *
 * Lives in its own class so {@link PluginHost} stays focused on
 * plugin-lifecycle concerns and so the contract — what plugins are
 * allowed to do — has a single, easily-testable home. New ctx
 * capabilities (scheduling, approval, completion-waits beyond emit)
 * land on this class as they are designed.
 *
 * Plugins must reach host capabilities only through `HostContext`;
 * see `feedback_plugin_ctx_only` in memory.
 */
export class HostContextImpl implements HostContext {
    private readonly deps: HostContextImplDeps;

    constructor(deps: HostContextImplDeps) {
        this.deps = deps;
    }

    readonly events = {
        emit: (event: NewEvent, options?: EmitOptions): Promise<EmitHandle> =>
            this.emitAndAwait(event, options),
        registerContextProvider: (fn: EventContextProvider): void => {
            this.deps.eventContextRegistry.register(this.deps.pluginId, fn);
        },
    };

    readonly chat = {
        subscribe: (filter: ChatFilter, handler: ChatHandler): Promise<ChatUnsubscribe> =>
            this.subscribeChat(filter, handler),
        appendAssistantMessage: (eventId: string, text: string): Promise<void> =>
            this.appendChatMessage(eventId, "assistant", text),
    };

    readonly mcp = {
        getList: (): readonly McpInfo[] => this.deps.mcp.getList(),
        getByKey: (key: string): McpClient => this.deps.mcp.getByKey(key),
        getByPackage: (pkg: string, source?: string): McpClient =>
            this.deps.mcp.getByPackage(pkg, source),
    };

    get calendar(): CalendarApi {
        return this.deps.calendar;
    }

    get mail(): MailApi {
        return this.deps.mail;
    }

    getMailStyleTemplate = (
        mailbox: string,
        name?: string,
    ): Promise<MailStyleTemplate | undefined> => this.deps.mailStyleStore.get(mailbox, name);

    readonly scratch = {
        addFiles: (eventId: string, files: readonly EventFile[]): Promise<readonly string[]> =>
            this.addScratchFiles(eventId, files),
    };

    readonly workspace: WorkspaceWatcherApi = {
        onFileUpdate: (
            filter: WorkspaceFileFilter,
            callback: (event: WorkspaceFileEvent) => void,
        ): (() => void) => {
            const watcher = this.deps.workspaceWatcher;
            if (!watcher) {
                throw new Error(
                    "ctx.workspace.onFileUpdate is only available inside the daemon (no workspace watcher in CLI mode)",
                );
            }
            return watcher.onFileUpdate(filter, (file) => {
                // The watcher's WorkspaceFile carries an optional `type`
                // tag on update notifications; defensively coerce to a
                // non-optional `kind` for the plugin-facing event.
                const kind = file.type ?? "changed";
                callback({
                    kind,
                    relativePath: file.relativePath,
                    absolutePath: file.absolutePath,
                });
            });
        },
    };

    log(message: string): void {
        this.deps.log.info(message);
    }

    get dataDir(): string {
        return this.deps.dataDir;
    }

    /**
     * Daemon-liveness probe. Used by CLI commands that go through the
     * bastion (`ctx.mcp.*`) so they can fail fast with a clear
     * "daemon not running" message instead of a misleading network
     * error from the bastion's port being closed.
     */
    isDaemonRunning(): boolean {
        return inspectPidFile(this.deps.pidFile).kind === "alive";
    }

    get config(): ConfigService {
        return this.deps.config;
    }

    get daemonDownSignal(): AbortSignal {
        return this.deps.daemonDownSignal;
    }

    /**
     * Open a {@link ChatMessageBus} subscription for the shared host
     * connection and return its unsubscribe disposer. The bus replays
     * undelivered matching messages on registration, so a plugin that
     * comes online after an assistant message was produced still sees
     * the message and can mark it delivered.
     */
    private async subscribeChat(
        filter: ChatFilter,
        handler: ChatHandler,
    ): Promise<ChatUnsubscribe> {
        const conn = await this.deps.ensureConnection();
        const bus = new ChatMessageBus(conn);
        return bus.subscribe(filter, handler);
    }

    /**
     * Insert a chatmessage attached to `eventId`. Used by
     * {@link HostContext.chat.appendUserMessage} and
     * `appendAssistantMessage`. Thin wrapper over
     * {@link ChatMessageBus.insert} so plugin code never reaches into
     * the bus directly.
     */
    private async appendChatMessage(
        eventId: string,
        role: "assistant",
        text: string,
    ): Promise<void> {
        const conn = await this.deps.ensureConnection();
        const bus = new ChatMessageBus(conn);
        await bus.insert({ eventId, role, textContent: text });
    }

    /**
     * Insert the event and return an {@link EmitHandle} as soon as the
     * row id is known. The handle's `settled` promise resolves on
     * `done` (with the final agentrun's `result_text`) or rejects on
     * `failed`.
     *
     * The state listener is installed *before* the INSERT to close the
     * race where the agent could process the event between the insert
     * returning and us subscribing. After insert, a one-shot SELECT
     * covers the (rarer) race where the event terminated before we
     * even saw the NOTIFY.
     *
     * When `options.onStep` is provided, a second LISTEN on
     * `stepresults_new` is installed (also before the INSERT) and the
     * callback is invoked for every step row whose `event_id` matches.
     * Errors thrown inside the callback are caught and logged so a
     * buggy subscriber can't break the emit.
     *
     * When `options.onAgentRun` is provided, an additional LISTEN on
     * `agentruns_changed` is installed (also before the INSERT) and the
     * callback is invoked for every agentrun row insert or state
     * transition whose `event_id` matches. Same error-swallowing
     * contract as `onStep`.
     *
     * If the INSERT itself fails, every installed listener is torn down
     * and the outer promise rejects. Once the handle is returned, the
     * caller owns awaiting `settled` (or attaching a `.catch`); listener
     * teardown is anchored on `settled` resolving or rejecting.
     */
    private async emitAndAwait(event: NewEvent, options?: EmitOptions): Promise<EmitHandle> {
        const conn = await this.deps.ensureConnection();
        const bus = new EventBus(conn);

        let waitedFor: string | undefined;
        let terminalState: "done" | "failed" | undefined;
        const wakers: Array<() => void> = [];
        const handler: NotificationHandler = (payload) => {
            const colon = payload.indexOf(":");
            if (colon < 0) {
                return;
            }
            const id = payload.slice(0, colon);
            const state = payload.slice(colon + 1);
            if (id !== waitedFor) {
                return;
            }
            if (state !== "done" && state !== "failed") {
                return;
            }
            terminalState = state;
            for (const wake of wakers.splice(0)) {
                wake();
            }
        };

        await conn.listen(EVENTS_STATE_CHANNEL, handler);
        let stepUnsubscribe: StepResultUnsubscribe | undefined;
        const onStep = options?.onStep;
        if (onStep) {
            const stepBus = new StepResultBus(conn);
            stepUnsubscribe = await stepBus.listen(async (step) => {
                if (step.eventId !== waitedFor) {
                    return;
                }
                try {
                    await onStep(step);
                } catch (err) {
                    this.deps.log.error(
                        {
                            stepId: step.id,
                            err: err instanceof Error ? err.message : String(err),
                        },
                        "events.emit onStep callback error",
                    );
                }
            });
        }

        let agentRunUnsubscribe: AgentRunUnsubscribe | undefined;
        const onAgentRun = options?.onAgentRun;
        if (onAgentRun) {
            const agentRunBus = new AgentRunBus(conn);
            agentRunUnsubscribe = await agentRunBus.listen(async (row) => {
                if (row.eventId !== waitedFor) {
                    return;
                }
                try {
                    await onAgentRun(row);
                } catch (err) {
                    this.deps.log.error(
                        {
                            agentRunId: row.id,
                            err: err instanceof Error ? err.message : String(err),
                        },
                        "events.emit onAgentRun callback error",
                    );
                }
            });
        }

        let row: Awaited<ReturnType<EventBus["add"]>>;
        let stagedScratchDir: string | undefined;
        try {
            // The only valid channel id is a non-empty string. Anything
            // else — `null`, `undefined`, `false`, `0`, `""`, an object
            // — is treated as "no preference" and triggers a fall back
            // to `core.defaultChatChannel`. Defensive against plugins
            // that hand in something the TypeScript shape forbids but
            // that slips through at runtime (untyped import, escape
            // cast, etc.); without this every such miss orphans any
            // `send_chat` reply produced while processing the event.
            const stamped: NewEvent = isUsableChannelId(event.preferredChatChannelId)
                ? event
                : {
                      ...event,
                      preferredChatChannelId: this.deps.config.getString("core.defaultChatChannel"),
                  };
            const files = event.files;
            row = await bus.add(stamped, async (insertedRow: EventRow) => {
                if (!files || files.length === 0) {
                    return;
                }
                // Staging happens inside the INSERT transaction, so
                // NOTIFY events_new (post-COMMIT) only fires once files
                // are on disk. If staging throws, the outer catch tears
                // down whatever partial dir we created — the EventBus
                // ROLLBACK keeps the database side clean.
                const targetDir = path.join(this.deps.scratchDir, insertedRow.id);
                stagedScratchDir = targetDir;
                await stageEventFiles(targetDir, files);
            });
            waitedFor = row.id;
        } catch (err) {
            if (stagedScratchDir) {
                await fs.rm(stagedScratchDir, { recursive: true, force: true });
            }
            // INSERT failed before we got an id — tear down listeners
            // and propagate.
            if (stepUnsubscribe) {
                await stepUnsubscribe();
            }
            if (agentRunUnsubscribe) {
                await agentRunUnsubscribe();
            }
            await conn.unlisten(EVENTS_STATE_CHANNEL, handler);
            throw err;
        }

        const daemonDownSignal = this.deps.daemonDownSignal;
        const onDaemonDown = () => {
            // Wake the `settled` loop so it can observe `signal.aborted`
            // and throw DaemonStoppedError instead of hanging on a
            // NOTIFY from a dying postgres.
            for (const wake of wakers.splice(0)) {
                wake();
            }
        };
        if (!daemonDownSignal.aborted) {
            daemonDownSignal.addEventListener("abort", onDaemonDown, { once: true });
        }

        const settled: Promise<string> = (async () => {
            try {
                if (daemonDownSignal.aborted) {
                    throw new DaemonStoppedError();
                }
                // Close the early-settle race: NOTIFY may have fired
                // between the INSERT and our setting `waitedFor`.
                const current = await fetchEventState(conn, row.id);
                if (current === "done" || current === "failed") {
                    terminalState = current;
                }

                while (!terminalState) {
                    if (daemonDownSignal.aborted) {
                        throw new DaemonStoppedError();
                    }
                    await new Promise<void>((resolve) => {
                        wakers.push(resolve);
                    });
                }

                if (terminalState === "failed") {
                    const err = await fetchFailureError(conn, row.id);
                    if (event.outputChatOnFailure === true) {
                        // Surface the failure through the same chat
                        // subscription path that delivers normal
                        // assistant replies. Await the INSERT so the
                        // NOTIFY fires (and the subscriber renders)
                        // before this promise rejects to the caller.
                        const bus = new ChatMessageBus(conn);
                        await bus
                            .insert({
                                eventId: row.id,
                                role: "assistant",
                                textContent: `Something went wrong processing the chat message: ${err ?? "(no error message)"}`,
                            })
                            .catch(() => {
                                // Best-effort: a write failure here
                                // shouldn't mask the original event
                                // failure that the caller actually needs.
                            });
                    }
                    throw new Error(
                        `Event ${row.id} (${event.topic}) failed: ${err ?? "(no error message)"}`,
                    );
                }
                return (await fetchFinalResultText(conn, row.id)) ?? "";
            } finally {
                daemonDownSignal.removeEventListener("abort", onDaemonDown);
                if (stepUnsubscribe) {
                    await stepUnsubscribe().catch(() => {});
                }
                if (agentRunUnsubscribe) {
                    await agentRunUnsubscribe().catch(() => {});
                }
                await conn.unlisten(EVENTS_STATE_CHANNEL, handler).catch(() => {});
            }
        })();

        // Suppress Node's unhandledRejection warning for callers that
        // never await `settled`. The subscribed no-op handler "marks"
        // the promise as handled at the V8 level without consuming
        // the rejection — callers that DO await still get the original
        // rejection because `await` reads the same resolved/rejected
        // state. Without this a plugin that emits-and-forgets crashes
        // the entire daemon as soon as any agentrun fails.
        void settled.catch(() => {});

        return { id: row.id, settled };
    }

    /**
     * Stage additional files into `/scratch/<eventId>/` for an event
     * that already exists. Mirrors the per-emit staging path used
     * inside {@link emitAndAwait}, but is callable later — typically
     * from a plugin tool that wants to drop fetched bytes (mail
     * attachments, downloaded reports) into the running agentrun's
     * scratch dir without round-tripping through `NewEvent.files`.
     *
     * The host's scratch dir is created if missing. Per-file basename
     * validation matches the emit path. Same-name collisions overwrite
     * — callers must pick unique names.
     */
    private async addScratchFiles(
        eventId: string,
        files: readonly EventFile[],
    ): Promise<readonly string[]> {
        if (typeof eventId !== "string" || eventId.length === 0) {
            throw new Error("scratch.addFiles: eventId must be a non-empty string");
        }
        const targetDir = path.join(this.deps.scratchDir, eventId);
        await stageEventFiles(targetDir, files);
        return files.map((f) => `/scratch/${eventId}/${validateEventFileName(f.name)}`);
    }
}

/**
 * Read the current `state` of an `events` row by id. Returns
 * `"unknown"` if the row vanished (shouldn't happen in normal flow).
 */
async function fetchEventState(conn: PostgresConnection, id: string): Promise<string> {
    const result = await conn
        .getPool()
        .query<{ state: string }>(`SELECT state FROM events WHERE id = $1`, [id]);
    return result.rows[0]?.state ?? "unknown";
}

/**
 * Fetch the most-recently-updated agentrun's `result_text` for an
 * event. Defines "the final agentrun" as whichever row's terminal
 * write triggered the event terminal recompute — i.e. the latest
 * `updated_at`. Returns `null` if the agentrun left it unset.
 */
async function fetchFinalResultText(
    conn: PostgresConnection,
    eventId: string,
): Promise<string | null> {
    const result = await conn.getPool().query<{ result_text: string | null }>(
        `SELECT result_text FROM agentruns
         WHERE event_id = $1
         ORDER BY updated_at DESC
         LIMIT 1`,
        [eventId],
    );
    return result.rows[0]?.result_text ?? null;
}

/**
 * Predicate guarding the chat-channel default-stamp in
 * `events.emit`. Returns `true` only when the value is a non-empty
 * string — every other shape (`null`, `undefined`, `false`, `0`,
 * empty string, object, array, …) gets stamped with
 * `core.defaultChatChannel` instead of being persisted as-is.
 *
 * Exported for unit testing; the production caller is the predicate
 * inside `events.emit`.
 */
export function isUsableChannelId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

/**
 * Validate a basename submitted as `EventFile.name`. Rejects empty,
 * path separators, `..` segments, and absolute-style leading slashes.
 * The check is intentionally strict — `name` is the literal basename
 * the file will land under inside `/scratch/<event-id>/`, no
 * subdirectories allowed.
 */
function validateEventFileName(name: unknown): string {
    if (typeof name !== "string" || name.length === 0) {
        throw new Error("EventFile.name must be a non-empty string");
    }
    if (name.includes("/") || name.includes("\\")) {
        throw new Error(`EventFile.name must be a basename without path separators: ${name}`);
    }
    if (name === "." || name === "..") {
        throw new Error(`EventFile.name must not be "." or "..": ${name}`);
    }
    return name;
}

/**
 * Stage each {@link EventFile} into `targetDir`. Creates the directory,
 * then for each file either writes the `contents` Buffer or moves the
 * file at `sourcePath` (falling back to copy+unlink across filesystems).
 * Caller is responsible for `rm -rf`-ing `targetDir` on failure.
 */
async function stageEventFiles(targetDir: string, files: readonly EventFile[]): Promise<void> {
    await fs.mkdir(targetDir, { recursive: true });
    for (const file of files) {
        const name = validateEventFileName(file.name);
        const targetPath = path.join(targetDir, name);
        if ("contents" in file) {
            await fs.writeFile(targetPath, file.contents);
            continue;
        }
        try {
            await fs.rename(file.sourcePath, targetPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
                throw err;
            }
            // Cross-device rename: fall back to copy + unlink so the
            // plugin still gives up ownership of the source file.
            await fs.copyFile(file.sourcePath, targetPath);
            await fs.unlink(file.sourcePath);
        }
    }
}

/**
 * Fetch the error message of the most-recently-updated `failed`
 * agentrun for an event. Returns `null` if no failed agentrun is
 * found (shouldn't happen if the event is in `failed`).
 */
async function fetchFailureError(
    conn: PostgresConnection,
    eventId: string,
): Promise<string | null> {
    const result = await conn.getPool().query<{ error: string | null }>(
        `SELECT error FROM agentruns
         WHERE event_id = $1 AND state = 'failed'
         ORDER BY updated_at DESC
         LIMIT 1`,
        [eventId],
    );
    return result.rows[0]?.error ?? null;
}
