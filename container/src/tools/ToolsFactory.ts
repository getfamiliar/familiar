import type {
    AgentRunBus,
    AgentRunRow,
    Logger,
    ScheduledHandlerBus,
    ToolRunContext,
} from "@getfamiliar/shared";
import type { ToolSet } from "ai";
import type { ChatManager } from "../chat/ChatManager.js";
import { buildBashTool } from "./bash.js";
import { buildCallHandlerTool, type WaitForSubagent } from "./callHandler.js";
import { buildFsTools } from "./fs.js";
import { buildGetScheduledHandlersTool } from "./getScheduledHandlers.js";
import { buildScheduleHandlerTool } from "./scheduleHandler.js";
import { buildSendChatTool } from "./sendChat.js";
import { evaluate, type GroupLookup, MCP_GROUP_NAME, parseExpression } from "./ToolFilter.js";
import { buildUnscheduleHandlerTool } from "./unscheduleHandler.js";

/**
 * Curated DSL groups every container-built-in tool joins. The
 * `core` group is the implicit default tool set handed to handlers
 * that omit `tools:`; `fs` bundles the filesystem family for
 * `tools: fs`; `reflection` collects introspection tools like
 * `get_scheduled_handlers`. Names not listed here are fine — new
 * groups are coined by listing them in this table or in a plugin
 * tool's `groups` field.
 *
 * Keys are the tool keys this factory may register; entries for
 * tools that didn't get registered (no chat context, etc.) are
 * silently skipped at build time so the resulting group sets only
 * include keys that are actually live for the agentrun.
 */
const CONTAINER_TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
    send_chat: ["core"],
    call_handler: ["core"],
    schedule_handler: ["core"],
    unschedule_handler: ["core"],
    get_scheduled_handlers: ["reflection"],
    fs_read: ["core", "fs"],
    fs_write: ["fs"],
    fs_str_replace: ["fs"],
    fs_append: ["fs"],
    fs_ls: ["fs"],
    fs_glob: ["fs"],
    fs_grep: ["fs"],
    fs_remove: ["fs"],
    bash: ["bash"],
};

/** Inputs the {@link AgentRunner} threads into the factory per agentrun. */
export interface ToolsFactoryContext {
    /** Chat history facade. When omitted, the `send_chat` tool is not registered. */
    readonly chat?: Pick<ChatManager, "fetchHistory" | "appendAssistantMessage">;
    /** Parent event id for the running agentrun; closed over by chat-aware tools. */
    readonly eventId?: string;
    /**
     * Tool-filter expression from the handler's `tools:` header.
     * When `undefined` or empty, the implicit default `core` group is
     * used (the union of every tool — built-in, host-core, or plugin —
     * whose `groups` lists `core`). See `tools/ToolFilter.ts` for the
     * full grammar and reserved group names.
     */
    readonly toolsExpression?: string;
    /**
     * Lazy lookup for user-defined groups in
     * `workspace/toolgroups/`. Built by `createGroupLookup()`. May
     * be omitted in tests; the resolver only invokes it for
     * non-built-in names, so simple expressions like `tools: all`
     * work without it.
     */
    readonly groups?: GroupLookup;
    /**
     * Agentrun bus; required to register `schedule_handler` (immediate
     * mode inserts a child agentrun) and `call_handler`.
     */
    readonly bus?: AgentRunBus;
    /**
     * Scheduled-handler bus; required to register `schedule_handler`,
     * `unschedule_handler`, and `get_scheduled_handlers`. The host's
     * `ScheduledHandlerScheduler` observes the same table and installs
     * Croner jobs for inserted rows.
     */
    readonly scheduledHandlerBus?: ScheduledHandlerBus;
    /**
     * IANA timezone (typically `core.timezone`) used by the scheduled-
     * handler tools to convert between wall-clock and UTC. When
     * omitted, the scheduled-handler tools are not registered.
     */
    readonly timezone?: string;
    /**
     * The currently-running agentrun row; closed over by
     * `schedule_handler` and `call_handler` for parent inheritance.
     */
    readonly parent?: AgentRunRow;
    /**
     * Scheduler-provided callback that, given a freshly-inserted
     * child agentrun id, suspends the parent until the child settles
     * and resolves with the child's terminal row. Required to register
     * `call_handler`; `schedule_handler` does not need it.
     */
    readonly waitForSubagent?: WaitForSubagent;
    /**
     * MCP-derived tools, namespaced as `${id}_${toolName}` by the
     * {@link McpClientPool}. Filtered through the same expression
     * as system tools — they share one available pool.
     */
    readonly mcpTools?: ToolSet;
    /**
     * Sanitized MCP id → the set of that MCP's sanitized tool keys.
     * Threaded into the evaluator's `builtins` so a handler's
     * `tools:` expression can reference an MCP id directly
     * (`tools: fetch + atlassian`) without a user-written toolgroup
     * file. Reserved names (`all`, `mcp`, `none`) cannot appear as
     * keys because the host's `mcp.yml` linter rejects them as ids.
     */
    readonly mcpKeysById?: ReadonlyMap<string, ReadonlySet<string>>;
    /**
     * Plugin-contributed tools, namespaced as `${pluginId}_${name}`
     * by the host's plugin-tools registry. Merged into the same
     * available pool as system + MCP tools so one `tools:`
     * expression decides what survives.
     */
    readonly pluginTools?: ToolSet;
    /**
     * Plugin id → the set of that plugin's sanitized tool keys.
     * Threaded into the evaluator's `builtins` so a handler can
     * write `tools: system + mail` to pull in every mail-plugin
     * tool. The host registry rejects plugin ids that collide
     * with reserved names or MCP ids, so the namespace is safe to
     * merge with `mcpKeysById`.
     */
    readonly pluginKeysById?: ReadonlyMap<string, ReadonlySet<string>>;
    /**
     * Curated group name → set of plugin / host-core tool keys
     * declaring membership. Mirrors each tool's `PluginTool.groups`
     * field. Folded into the same per-group map the container's
     * built-ins populate, so e.g. `groups: ["core"]` on the memory
     * plugin's `memory_save` adds its key to the implicit-default
     * `core` set without any other plumbing.
     */
    readonly pluginGroupKeys?: ReadonlyMap<string, ReadonlySet<string>>;
    /**
     * Per-call runner context (byte budget + spill function). Threaded
     * into every container-side tool wrapper so the three
     * {@link import("@getfamiliar/shared").runJsonTool}-family runners
     * can offload oversized results to scratch consistently. Required
     * whenever any container-side system tool will be registered.
     */
    readonly toolRunContext?: ToolRunContext;
    /**
     * Logger child for filter diagnostics. Resolution errors throw
     * so the agentrun fails loud; warnings are not currently
     * emitted (kept for future use).
     */
    readonly log?: Logger;
}

/**
 * Builds the tool set the {@link import("../agent-runner/AgentRunner").AgentRunner}
 * hands to the Vercel AI SDK's tool-loop agent.
 *
 * **One pool, one filter.** Built-in container tools (`send_chat`,
 * `schedule_handler`, `call_handler`, `unschedule_handler`,
 * `get_scheduled_handlers`, `fs_*`), MCP tools (`${id}_${name}`), and
 * plugin tools are merged into a single available set. The handler's
 * `tools:` expression — or, when omitted, the implicit `core` default
 * — decides what survives.
 *
 * Built-in groups visible from any expression:
 *
 * - `all`  — every key in the available pool.
 * - `mcp`  — just the MCP-tool keys.
 * - `none` — empty set; lets a child handler override its parent's
 *   `tools:` to nothing under the replace-merge rule.
 *
 * Curated groups like `core`, `fs`, `reflection` are populated by
 * the union of every tool whose declaration lists them — see
 * {@link CONTAINER_TOOL_GROUPS} for container built-ins and each
 * plugin tool's `PluginTool.groups` for the rest.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Reserved as a growth point for tool registration.
export class ToolsFactory {
    /**
     * Build the tool set for one agentrun. Fully evaluates the
     * `tools:` expression (or the implicit `core` default) against
     * the unified system + MCP + plugin pool and returns the
     * projected `ToolSet`.
     */
    static build(context: ToolsFactoryContext = {}): ToolSet {
        const systemTools: ToolSet = {};
        const toolRunContext = context.toolRunContext ?? FALLBACK_TOOL_RUN_CONTEXT;
        if (context.chat && context.eventId) {
            systemTools.send_chat = buildSendChatTool(
                context.chat,
                context.eventId,
                toolRunContext,
            );
        }
        if (context.bus && context.parent && context.waitForSubagent) {
            systemTools.call_handler = buildCallHandlerTool(
                context.bus,
                context.parent,
                context.waitForSubagent,
                toolRunContext,
            );
        }
        if (context.scheduledHandlerBus && context.parent && context.timezone) {
            if (context.bus) {
                systemTools.schedule_handler = buildScheduleHandlerTool(
                    context.bus,
                    context.scheduledHandlerBus,
                    context.parent,
                    context.timezone,
                    toolRunContext,
                );
            }
            systemTools.unschedule_handler = buildUnscheduleHandlerTool(
                context.scheduledHandlerBus,
                toolRunContext,
            );
            systemTools.get_scheduled_handlers = buildGetScheduledHandlersTool(
                context.scheduledHandlerBus,
                context.timezone,
                toolRunContext,
            );
        }
        if (context.parent) {
            // Filesystem tools are always available; the writing tools
            // (fs_write / fs_str_replace / fs_append) consult
            // `parent.privileged` internally to gate everything outside
            // core.writablePaths / scratch, so every agentrun can read but
            // only privileged runs modify protected paths.
            Object.assign(systemTools, buildFsTools(context.parent, toolRunContext));
            // The bash tool lives in its own opt-in `bash` group (handlers
            // request it via `tools: bash`). Privileged runs run as `priv`,
            // non-privileged drop to `unpriv`; the OS enforces the boundary.
            systemTools.bash = buildBashTool(context.parent, toolRunContext, context.log);
        }

        const mcpTools = context.mcpTools ?? {};
        const pluginTools = context.pluginTools ?? {};
        const allTools: ToolSet = { ...systemTools, ...mcpTools, ...pluginTools };
        const availableKeys = new Set(Object.keys(allTools));
        const mcpKeys = new Set(Object.keys(mcpTools));

        // Per-group key map. Container built-ins fold in via the
        // static `CONTAINER_TOOL_GROUPS` table (only keys actually
        // registered above are considered, so a scenario without
        // chat context doesn't promote a non-existent `send_chat`
        // into `core`). Plugin / host-core tools fold in via
        // `pluginGroupKeys`, sourced from each `PluginTool.groups`.
        const groupKeys = new Map<string, Set<string>>();
        for (const key of Object.keys(systemTools)) {
            const groups = CONTAINER_TOOL_GROUPS[key];
            if (!groups) {
                continue;
            }
            for (const group of groups) {
                let set = groupKeys.get(group);
                if (set === undefined) {
                    set = new Set();
                    groupKeys.set(group, set);
                }
                set.add(key);
            }
        }
        if (context.pluginGroupKeys) {
            for (const [group, keys] of context.pluginGroupKeys) {
                let set = groupKeys.get(group);
                if (set === undefined) {
                    set = new Set();
                    groupKeys.set(group, set);
                }
                for (const key of keys) {
                    // Defensive: only include keys that actually
                    // landed in the merged pool. A plugin tool that
                    // never showed up (bastion fetch failed, …)
                    // should not silently appear under its declared
                    // groups.
                    if (allTools[key] !== undefined) {
                        set.add(key);
                    }
                }
            }
        }

        const matched = resolveMatched({
            available: availableKeys,
            mcpKeys,
            mcpKeysById: context.mcpKeysById,
            pluginKeysById: context.pluginKeysById,
            groupKeys,
            toolsExpression: context.toolsExpression,
            lookup: context.groups,
        });

        const out: ToolSet = {};
        for (const name of matched) {
            const tool = allTools[name];
            if (tool !== undefined) {
                out[name] = tool;
            }
        }
        return out;
    }
}

/**
 * Compute the set of tool keys that pass the handler's filter.
 *
 * - `tools:` undefined or empty ⇒ implicit `core` (the union of every
 *   tool whose declared `groups` lists `core`; empty when no tool
 *   opted in for this agentrun).
 * - `tools:` set ⇒ parse the expression and evaluate against the
 *   unified pool. Curated and identity-derived groups are supplied
 *   via the `builtins` map; `all` and `none` are handled by the
 *   evaluator from `available`; `mcp` resolves to the MCP-key set.
 */
function resolveMatched(args: {
    available: ReadonlySet<string>;
    mcpKeys: ReadonlySet<string>;
    mcpKeysById: ReadonlyMap<string, ReadonlySet<string>> | undefined;
    pluginKeysById: ReadonlyMap<string, ReadonlySet<string>> | undefined;
    groupKeys: ReadonlyMap<string, ReadonlySet<string>>;
    toolsExpression: string | undefined;
    lookup: GroupLookup | undefined;
}): Set<string> {
    if (args.toolsExpression === undefined || args.toolsExpression.trim().length === 0) {
        return new Set(args.groupKeys.get("core") ?? new Set());
    }
    const expressionForError = JSON.stringify(args.toolsExpression);
    let ast: ReturnType<typeof parseExpression>;
    try {
        ast = parseExpression(args.toolsExpression);
    } catch (err) {
        throw new Error(
            `Cannot parse tools frontmatter attribute ${expressionForError}, aborting: ${errorMessage(err)}`,
            { cause: err },
        );
    }
    // Order matters only on collisions, which the host-side linters
    // already preclude — but we still write curated groups first,
    // then identity-derived auto-groups, then `mcp` last, so the
    // reserved-name semantics win unambiguously.
    const builtins = new Map<string, ReadonlySet<string>>();
    for (const [name, keys] of args.groupKeys) {
        builtins.set(name, keys);
    }
    if (args.mcpKeysById) {
        for (const [id, keys] of args.mcpKeysById) {
            builtins.set(id, keys);
        }
    }
    if (args.pluginKeysById) {
        for (const [id, keys] of args.pluginKeysById) {
            builtins.set(id, keys);
        }
    }
    builtins.set(MCP_GROUP_NAME, args.mcpKeys);
    const lookup = args.lookup ?? rejectAnyLookup;
    try {
        return evaluate(ast, args.available, lookup, builtins);
    } catch (err) {
        throw new Error(
            `Cannot resolve tools frontmatter attribute ${expressionForError}, aborting: ${errorMessage(err)}`,
            { cause: err },
        );
    }
}

/**
 * Best-effort extraction of a human-readable message from a thrown value.
 * Falls back to `String(err)` when `err` is not an `Error`.
 */
function errorMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

/**
 * Default lookup used when no group-loader was wired in (tests,
 * future call sites). Always resolves to "no such group" — the
 * resolver translates that to `unknown group: <name>`.
 */
const rejectAnyLookup: GroupLookup = () => undefined;

/**
 * Inert {@link ToolRunContext} for callers (typically tests) that
 * build a {@link ToolsFactory} without wiring scratch offloading.
 * The 10000-byte limit matches the platform default; the `spill`
 * stub throws to make accidental offload attempts loud rather than
 * silently dropping bytes.
 */
const FALLBACK_TOOL_RUN_CONTEXT: ToolRunContext = {
    limit: 10000,
    spill: () => {
        throw new Error(
            "ToolsFactory.build was called without a toolRunContext; " +
                "configure one (with a real scratch spill) before exercising tools that " +
                "may exceed the inline byte budget.",
        );
    },
};
