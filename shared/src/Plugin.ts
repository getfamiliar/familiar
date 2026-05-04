import type { CommandDef } from "citty";
import type { ChatFilter } from "./ChatMessage";
import type { ChatHandler, ChatUnsubscribe } from "./ChatMessageBus";
import type { NewEvent } from "./Event";
import type { StepResultRow } from "./StepResult";

export type { ChatHandler };

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
export interface HostContext {
    /**
     * Emit an event into the bus and **wait** for it to settle.
     *
     * On `done`: returns the `result_text` of the last-settled
     * agentrun for the event (empty string if the handler wrote no
     * text). On `failed`: throws an `Error` carrying that agentrun's
     * `error` message.
     *
     * Implementation subscribes to `events_state` before inserting
     * to avoid missing the terminal NOTIFY on a fast-processed event.
     *
     * @param onStep Optional callback fired for every step row
     *   inserted into `stepresults` for this event, in INSERT order.
     *   Errors thrown by the callback are caught and logged so a bad
     *   subscriber can't break the emit. When omitted, no
     *   `stepresults_new` LISTEN is registered (zero overhead).
     */
    readonly events: {
        emit(
            event: NewEvent,
            onStep?: (step: StepResultRow) => void | Promise<void>,
        ): Promise<string>;
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
    /** Structured-ish log line. Future: scoped by plugin id, severity, etc. */
    readonly log: (message: string) => void;
}

/**
 * One scheduled invocation of a CLI command, declared by a plugin.
 *
 * Cronjobs deliberately call back into the CLI rather than running
 * arbitrary in-process code: every scheduled action is also a
 * manually-invokable command, which is invaluable for debugging and
 * audit. The scheduler implementation is deferred — this type just
 * fixes the manifest shape.
 */
export interface PluginCronjob {
    /** Standard cron expression (e.g. `0 8 * * 1`). */
    readonly schedule: string;
    /** CLI argv to invoke. First element is typically the plugin id. */
    readonly command: readonly string[];
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
     * Long-running daemon (sockets, listeners, etc.). Awaited at host
     * startup; should resolve once setup is done. Long-lived work
     * lives on background promises the daemon owns.
     */
    start?(ctx: HostContext): Promise<void>;
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
    /**
     * Cronjob declarations. Scheduler implementation is a separate
     * plan; for now this is data only.
     */
    cronjobs?(ctx: HostContext): readonly PluginCronjob[];
}

/**
 * Container-side surface a plugin may declare. Loader implementation
 * (mount built plugin output into the container, scan + import at
 * startup) is deferred — cli-chat doesn't need it. The field shape
 * exists so future plugins can declare it without breaking the
 * manifest type.
 */
export interface PluginContainerManifest {
    /**
     * Path (relative to the plugin package's build output) of the
     * module the container imports for tools. The container's tool
     * loader will scan `/plugins/<id>/<toolsModule>` once mounting is
     * implemented.
     */
    readonly toolsModule?: string;
}

/**
 * The full plugin manifest shape returned by {@link definePlugin}.
 *
 * A minimal plugin needs only `id`. Any combination of `host`,
 * `container`, and `workspaceTemplate` may be added — they are
 * independent concerns.
 */
export interface PluginManifest {
    /**
     * Plugin id, matching `[a-z0-9-]+`. Used to namespace the
     * plugin's CLI commands (`cli.sh <id> <subcommand>`) and as the
     * container mount subdirectory once container loading lands.
     */
    readonly id: string;
    /** Host-side surface (CLI commands, daemons, cronjobs). */
    readonly host?: PluginHostManifest;
    /** Container-side surface (tools). Loader deferred. */
    readonly container?: PluginContainerManifest;
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
