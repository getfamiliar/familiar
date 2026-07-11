import {
    type AgentRunBus,
    type AgentRunRow,
    type ContainerToolInfo,
    DEFAULT_TOOL_LEVEL,
    estimateTokens,
    type Logger,
    type ScheduledSubagentBus,
    type ToolCallBus,
    ToolError,
    type ToolLevel,
    type ToolRunContext,
} from "@getfamiliar/shared";
import { asSchema, type Tool, type ToolSet } from "ai";
import type { ChatManager } from "../chat/ChatManager.js";
import { buildBashTool } from "./bash.js";
import { buildFsTools } from "./fs.js";
import { buildGetScheduledSubagentsTool } from "./getScheduledSubagents.js";
import { buildScheduleSubagentTool } from "./scheduleSubagent.js";
import { buildSendChatTool } from "./sendChat.js";
import { buildStartSubagentTool, type WaitForSubagent } from "./startSubagent.js";
import { MCP_GROUP_NAME, resolveTools } from "./ToolsExpressionParser.js";
import { buildToolCallTool } from "./toolCall.js";
import { buildToolDescribeTool } from "./toolDescribe.js";
import { buildToolListTool, type ToolCatalogEntry } from "./toolList.js";
import { buildUnscheduleSubagentTool } from "./unscheduleSubagent.js";

/** Agent-facing keys of the always-present discovery meta-tools. */
const TOOL_LIST_KEY = "tool_list";
const TOOL_CALL_KEY = "tool_call";
const TOOL_DESCRIBE_KEY = "tool_describe";

/**
 * Default per-tool description clamp (characters). Keeps individual
 * tool definitions compact in the model-facing toolset; overridable via
 * `core.maxToolDescriptionChars`.
 */
const DEFAULT_MAX_TOOL_DESCRIPTION_CHARS = 1024;

/**
 * Default fraction of the model's context window budgeted for
 * heuristically auto-loaded tool definitions. Overridable via
 * `core.toolDefinitionsContextFraction`.
 */
const DEFAULT_TOOL_DEFINITIONS_CONTEXT_FRACTION = 0.15;

/**
 * Default number of recent non-error runs the heuristic scans for a
 * handler's tool usage. Overridable via `core.toolHeuristicRunWindow`.
 */
const DEFAULT_TOOL_HEURISTIC_RUN_WINDOW = 20;

/**
 * Number of heuristic candidates to load when the model's context
 * window size is unknown (metadata missing), so warm handlers still
 * benefit without a token budget to size against.
 */
const FALLBACK_HEURISTIC_TOOL_CAP = 10;

/**
 * Curated groups every container-built-in tool joins. The
 * `core` group is the implicit default tool set handed to handlers
 * that omit `tools:`; `fs` bundles the filesystem family for
 * `tools: fs`; `reflection` collects introspection tools like
 * `get_scheduled_subagents`. Names not listed here are fine — new
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
    start_subagent: ["core"],
    schedule_subagent: ["core"],
    unschedule_subagent: ["core"],
    get_scheduled_subagents: ["reflection"],
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

/**
 * Security level for container built-ins that are not `default`. Any
 * key absent here (including every built-in above and the meta-tools)
 * is `default`. See {@link import("@getfamiliar/shared").ToolLevel}.
 *
 * Deliberately empty today: the fs write tools keep their finer
 * path-scoped privilege gate (a blanket `privileged` would wrongly
 * block their legitimate non-privileged scratch writes), and `bash`
 * keeps its OS-confined `unpriv` downgrade. The non-`default` tools
 * currently live on the plugin side (`mail_send_*`, `event_replay`,
 * `mailstyle_update`); this table exists so built-ins can be
 * reclassified without new plumbing.
 */
const CONTAINER_TOOL_LEVELS: Readonly<Record<string, ToolLevel>> = {};

/** Inputs the {@link AgentRunner} threads into the factory per agentrun. */
export interface ToolsFactoryContext {
    /** Chat history facade. When omitted, the `send_chat` tool is not registered. */
    readonly chat?: Pick<ChatManager, "fetchHistory" | "appendAssistantMessage">;
    /** Parent event id for the running agentrun; closed over by chat-aware tools. */
    readonly eventId?: string;
    /**
     * Normalized `tools:` entries from the handler header — explicit
     * tool names, `*`-globs, and group names, resolved independently
     * and unioned. When `undefined` or empty, the implicit default
     * `core` group is used (the union of every tool — built-in,
     * host-core, or plugin — whose `groups` lists `core`). See
     * `tools/ToolsExpressionParser.ts` for resolution and reserved
     * group names.
     */
    readonly tools?: readonly string[];
    /**
     * Agentrun bus; required to register `schedule_subagent` (immediate
     * mode inserts a child agentrun) and `start_subagent`.
     */
    readonly bus?: AgentRunBus;
    /**
     * Scheduled-subagent bus; required to register `schedule_subagent`,
     * `unschedule_subagent`, and `get_scheduled_subagents`. The host's
     * `ScheduledSubagentScheduler` observes the same table and installs
     * Croner jobs for inserted rows.
     */
    readonly scheduledSubagentBus?: ScheduledSubagentBus;
    /**
     * IANA timezone (typically `core.timezone`) used by the scheduled-
     * subagent tools to convert between wall-clock and UTC. When
     * omitted, the scheduled-subagent tools are not registered.
     */
    readonly timezone?: string;
    /**
     * The currently-running agentrun row; closed over by
     * `schedule_subagent` and `start_subagent` for parent inheritance.
     */
    readonly parent?: AgentRunRow;
    /**
     * Scheduler-provided callback that, given a freshly-inserted
     * child agentrun id, suspends the parent until the child settles
     * and resolves with the child's terminal row. Required to register
     * `start_subagent`; `schedule_subagent` does not need it.
     */
    readonly waitForSubagent?: WaitForSubagent;
    /**
     * MCP-derived tools, namespaced as `${id}_${toolName}` by the
     * {@link McpClientPool}. Resolved against the same `tools:` entries
     * as system tools — they share one available pool.
     */
    readonly mcpTools?: ToolSet;
    /**
     * Sanitized MCP id → the set of that MCP's sanitized tool keys.
     * Threaded into the resolver's `builtins` so a handler's `tools:`
     * can reference an MCP id directly (`tools: fetch, atlassian`).
     * Reserved names (`all`, `mcp`, `none`) cannot appear as keys
     * because the host's `mcp.yml` linter rejects them as ids.
     */
    readonly mcpKeysById?: ReadonlyMap<string, ReadonlySet<string>>;
    /**
     * Plugin-contributed tools, namespaced as `${pluginId}_${name}`
     * by the host's plugin-tools registry. Merged into the same
     * available pool as system + MCP tools so one `tools:` list
     * decides what survives.
     */
    readonly pluginTools?: ToolSet;
    /**
     * Plugin id → the set of that plugin's sanitized tool keys.
     * Threaded into the resolver's `builtins` so a handler can write
     * `tools: core, mail` to pull in every mail-plugin tool. The host
     * registry rejects plugin ids that collide with reserved names or
     * MCP ids, so the namespace is safe to merge with `mcpKeysById`.
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
     * Plugin tool key → its security {@link ToolLevel}, from the
     * host-resolved `/plugin-tools/` catalog. Folded into the per-key
     * level map `build()` assembles (together with
     * `CONTAINER_TOOL_LEVELS`) so the tool wrapper can refuse a
     * non-`default` tool in a non-privileged run.
     */
    readonly pluginLevelsByKey?: ReadonlyMap<string, ToolLevel>;
    /**
     * MCP tool key (`${id}_${name}`) → its security {@link ToolLevel},
     * resolved from each MCP's `mcp.yml` `approval` / `privileged`
     * globs by the {@link import("../mcp/McpClientPool").McpClientPool}.
     * Folded into the per-key level map alongside built-in and plugin
     * levels; keys absent here are `default`.
     */
    readonly mcpLevelsByKey?: ReadonlyMap<string, ToolLevel>;
    /**
     * Per-call runner context (byte budget + spill function). Threaded
     * into every container-side tool wrapper so the three
     * {@link import("@getfamiliar/shared").runJsonTool}-family runners
     * can offload oversized results to scratch consistently. Required
     * whenever any container-side system tool will be registered.
     */
    readonly toolRunContext?: ToolRunContext;
    /**
     * Logger child for resolution diagnostics. Resolution errors throw
     * so the agentrun fails loud; warnings are not currently
     * emitted (kept for future use).
     */
    readonly log?: Logger;
    /**
     * Tool-call recorder. When present (together with `handlerPath` and
     * a `parent` carrying an id), every tool invocation is written to
     * `tool_calls` — feeding both the audit trail and the heuristic
     * preloader. Absent in test / catalog paths, which then skip
     * recording and preloading.
     */
    readonly toolCallBus?: ToolCallBus;
    /**
     * Resolved handler markdown path (workspace-relative, e.g.
     * `chat/telegram/index.md`). Keys the heuristic: the tools this
     * handler successfully used across its recent non-error runs are
     * auto-loaded up front. Also stamped on every recorded tool call.
     */
    readonly handlerPath?: string;
    /**
     * Resolved model's context window in tokens. Bounds how many
     * heuristic tools are auto-loaded (a fraction of this budgets their
     * definitions). When undefined, a fixed candidate cap applies.
     */
    readonly contextLimit?: number;
    /** Per-tool description clamp; defaults to {@link DEFAULT_MAX_TOOL_DESCRIPTION_CHARS}. */
    readonly maxToolDescriptionChars?: number;
    /** Fraction of `contextLimit` budgeted for auto-loaded tool defs; see default. */
    readonly toolDefinitionsContextFraction?: number;
    /** How many recent non-error runs the heuristic scans; see default. */
    readonly toolHeuristicRunWindow?: number;
}

/**
 * Builds the tool set the {@link import("../agent-runner/AgentRunner").AgentRunner}
 * hands to the Vercel AI SDK's tool-loop agent.
 *
 * **One pool, one resolution.** Built-in container tools (`send_chat`,
 * `schedule_subagent`, `start_subagent`, `unschedule_subagent`,
 * `get_scheduled_subagents`, `fs_*`), MCP tools (`${id}_${name}`), and
 * plugin tools are merged into a single available set. The handler's
 * `tools:` entries — or, when omitted, the implicit `core` default —
 * decide what survives.
 *
 * Built-in groups available to any handler:
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
     * Build the tool set for one agentrun.
     *
     * The handler's `tools:` entries (or the implicit `core` default)
     * are the **guaranteed** preload — always present. On top of that,
     * the heuristic auto-loads the tools this handler has recently used
     * (bounded by a token budget), and the always-present `tool_list` /
     * `tool_call` meta-tools let the agent reach anything else in the
     * pool. Every non-meta tool is wrapped so its calls are recorded
     * (feeding the heuristic) and its description is clamped.
     */
    static async build(context: ToolsFactoryContext = {}): Promise<ToolSet> {
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
            systemTools.start_subagent = buildStartSubagentTool(
                context.bus,
                context.parent,
                context.waitForSubagent,
                toolRunContext,
            );
        }
        if (context.scheduledSubagentBus && context.parent && context.timezone) {
            if (context.bus) {
                systemTools.schedule_subagent = buildScheduleSubagentTool(
                    context.bus,
                    context.scheduledSubagentBus,
                    context.parent,
                    context.timezone,
                    toolRunContext,
                );
            }
            systemTools.unschedule_subagent = buildUnscheduleSubagentTool(
                context.scheduledSubagentBus,
                toolRunContext,
            );
            systemTools.get_scheduled_subagents = buildGetScheduledSubagentsTool(
                context.scheduledSubagentBus,
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

        // Per-key security level: built-ins from CONTAINER_TOOL_LEVELS,
        // plugin tools from the host-resolved catalog. MCP keys are
        // absent ⇒ `default`. Drives the wrapper's privilege guard and
        // the `tool_list` listing.
        const levelsByKey = buildLevelsByKey(context, systemTools);
        const privileged = context.parent?.privileged ?? false;

        // Wrap every pool tool once: enforce its security level, clamp
        // its description, and record each invocation. Both the projected
        // toolset and `tool_call` dispatch through this wrapped map, so a
        // proxied call is guarded and recorded under the real tool name
        // exactly as a direct call would be.
        const maxDescriptionChars =
            context.maxToolDescriptionChars ?? DEFAULT_MAX_TOOL_DESCRIPTION_CHARS;
        const record = buildToolCallRecorder(context);
        const wrappedTools: ToolSet = {};
        for (const [name, t] of Object.entries(allTools)) {
            const level = levelsByKey.get(name) ?? DEFAULT_TOOL_LEVEL;
            wrappedTools[name] = wrapTool(name, t, maxDescriptionChars, record, level, privileged);
        }

        // The guaranteed set: the handler's `tools:` (empty ⇒ implicit
        // `core`). Always loaded, never dropped by the budget.
        const guaranteed = resolveMatched({
            available: availableKeys,
            mcpKeys,
            mcpKeysById: context.mcpKeysById,
            pluginKeysById: context.pluginKeysById,
            groupKeys,
            tools: context.tools,
        });

        const out: ToolSet = {};
        for (const name of guaranteed) {
            const tool = wrappedTools[name];
            if (tool !== undefined) {
                out[name] = tool;
            }
        }

        // Heuristic auto-load: this handler's recently-used tools, most-
        // used first, filling the tool-definition token budget left over
        // after the guaranteed set. Never overrides an already-loaded key.
        const heuristic = await selectHeuristicTools({
            context,
            allTools,
            guaranteed,
        });
        for (const name of heuristic) {
            if (out[name] === undefined && wrappedTools[name] !== undefined) {
                out[name] = wrappedTools[name];
            }
        }

        // Discovery meta-tools are always present and bypass the filter,
        // so the agent can always find and invoke the rest of the pool.
        // They are not wrapped (discovery is not heuristic signal, and
        // `tool_call` delegates to the already-wrapped pool).
        const loaded = new Set(Object.keys(out));
        const catalog: ToolCatalogEntry[] = Object.entries(allTools).map(([name, t]) => ({
            name,
            description: t.description ?? "",
            level: levelsByKey.get(name) ?? DEFAULT_TOOL_LEVEL,
        }));
        const metaToolRunContext = context.toolRunContext ?? FALLBACK_TOOL_RUN_CONTEXT;
        out[TOOL_LIST_KEY] = buildToolListTool(catalog, loaded, metaToolRunContext);
        out[TOOL_CALL_KEY] = buildToolCallTool(wrappedTools);
        out[TOOL_DESCRIBE_KEY] = buildToolDescribeTool(
            allTools,
            levelsByKey,
            loaded,
            metaToolRunContext,
        );
        return out;
    }

    /**
     * Enumerate every container built-in as a flat catalog of name +
     * description + raw JSON input schema + curated groups. The
     * container POSTs this to the host's `/container-tools/` bastion
     * endpoint on startup so the `tools list` CLI can show built-ins
     * without a hand-maintained host-side copy.
     *
     * Each tool is constructed through its real builder with inert stub
     * deps: construction never touches the runtime deps (they are only
     * used inside `execute`), so the descriptions and schemas read here
     * are exactly what the agent is offered — there is nothing to drift.
     * Group memberships come from {@link CONTAINER_TOOL_GROUPS}, the same
     * map `build()` filters against. Unlike `build()`, every built-in is
     * enumerated unconditionally (no chat / parent / bus gating).
     */
    static async catalog(): Promise<ContainerToolInfo[]> {
        const ctx = FALLBACK_TOOL_RUN_CONTEXT;
        const chat = {} as Parameters<typeof buildSendChatTool>[0];
        const bus = {} as AgentRunBus;
        const scheduled = {} as ScheduledSubagentBus;
        const parent = {} as AgentRunRow;
        const waitForSubagent: WaitForSubagent = async () => {
            throw new Error("ToolsFactory.catalog stub: waitForSubagent must not be invoked");
        };
        const tools: ToolSet = {
            send_chat: buildSendChatTool(chat, "", ctx),
            start_subagent: buildStartSubagentTool(bus, parent, waitForSubagent, ctx),
            schedule_subagent: buildScheduleSubagentTool(bus, scheduled, parent, "UTC", ctx),
            unschedule_subagent: buildUnscheduleSubagentTool(scheduled, ctx),
            get_scheduled_subagents: buildGetScheduledSubagentsTool(scheduled, "UTC", ctx),
            ...buildFsTools(parent, ctx),
            bash: buildBashTool(parent, ctx),
        };

        const out: ContainerToolInfo[] = [];
        for (const [name, t] of Object.entries(tools)) {
            out.push({
                name,
                description: t.description ?? "",
                inputSchema: await readRawInputSchema(t),
                groups: CONTAINER_TOOL_GROUPS[name] ?? [],
                level: CONTAINER_TOOL_LEVELS[name] ?? DEFAULT_TOOL_LEVEL,
            });
        }
        return out;
    }
}

/**
 * Resolve a built-in tool's raw JSON Schema. Container built-ins all
 * declare `inputSchema` via `jsonSchema(<plain object>)`, so `asSchema`
 * yields a `Schema` whose `.jsonSchema` is that plain object —
 * synchronous in practice, awaited here to satisfy the SDK's
 * `JSONSchema7 | PromiseLike<JSONSchema7>` type.
 */
async function readRawInputSchema(tool: Tool): Promise<object> {
    const resolved = await Promise.resolve(asSchema(tool.inputSchema).jsonSchema);
    return resolved as object;
}

/**
 * Compute the set of tool keys the handler's `tools:` entries select.
 *
 * - `tools:` undefined or empty ⇒ implicit `core` (the union of every
 *   tool whose declared `groups` lists `core`; empty when no tool
 *   opted in for this agentrun).
 * - `tools:` set ⇒ resolve each entry against the unified pool and
 *   union. Curated and identity-derived groups are supplied via the
 *   `builtins` map; `all` and `none` resolve from `available`; `mcp`
 *   resolves to the MCP-key set.
 */
function resolveMatched(args: {
    available: ReadonlySet<string>;
    mcpKeys: ReadonlySet<string>;
    mcpKeysById: ReadonlyMap<string, ReadonlySet<string>> | undefined;
    pluginKeysById: ReadonlyMap<string, ReadonlySet<string>> | undefined;
    groupKeys: ReadonlyMap<string, ReadonlySet<string>>;
    tools: readonly string[] | undefined;
}): Set<string> {
    if (args.tools === undefined || args.tools.length === 0) {
        return new Set(args.groupKeys.get("core") ?? new Set());
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
    try {
        return resolveTools(args.tools, args.available, builtins);
    } catch (err) {
        throw new Error(
            `Cannot resolve tools frontmatter attribute ${JSON.stringify(args.tools)}, aborting: ${errorMessage(err)}`,
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
 * Build the fire-and-forget tool-call recorder. Returns a no-op when
 * the recording deps (bus, handler path, agentrun id) aren't all
 * present (test / catalog paths). Recording never faults the tool
 * result — an audit-write failure is logged and swallowed.
 */
function buildToolCallRecorder(
    context: ToolsFactoryContext,
): (toolName: string, successful: boolean) => void {
    const bus = context.toolCallBus;
    const handlerPath = context.handlerPath;
    const agentRunId = context.parent?.id;
    if (bus === undefined || handlerPath === undefined || agentRunId === undefined) {
        return () => {};
    }
    return (toolName, successful) => {
        void bus.add({ agentRunId, handlerPath, toolName, successful }).catch((err) => {
            context.log?.warn(
                `failed to record tool call ${toolName} (successful=${successful}) for handler ${handlerPath}: ${errorMessage(err)}`,
            );
        });
    };
}

/**
 * Wrap one pool tool: clamp its description to `maxDescriptionChars`
 * and record each invocation's outcome. `successful` is "execute did
 * not throw" — a hard throw is the clean "don't preload this" signal;
 * tools that report errors in-band still count as successful (a known
 * limitation of this first cut). Tools without an `execute` (not
 * expected in this pool) are description-clamped only.
 */
function wrapTool(
    name: string,
    original: Tool,
    maxDescriptionChars: number,
    record: (toolName: string, successful: boolean) => void,
    level: ToolLevel,
    privileged: boolean,
): Tool {
    const description = clampDescription(original.description, maxDescriptionChars);
    const originalExecute = original.execute as
        | ((input: unknown, options: unknown) => unknown)
        | undefined;
    if (typeof originalExecute !== "function") {
        return { ...original, description } as Tool;
    }
    // A privileged (or, until the approval gate exists, approval-level)
    // tool refuses in a non-privileged run. The guard short-circuits
    // before execute — the tool never ran, so the refusal is not
    // recorded to `tool_calls`. The tool stays visible in the toolset /
    // `tool_list`; only the invocation errors.
    const guarded = !privileged && (level === "privileged" || level === "approval");
    return {
        ...original,
        description,
        execute: async (args: unknown, options: unknown) => {
            if (guarded) {
                throw new ToolError("PrivilegeDenied", toolLevelRefusal(name, level));
            }
            try {
                const result = await originalExecute(args, options);
                record(name, true);
                return result;
            } catch (err) {
                record(name, false);
                throw err;
            }
        },
    } as Tool;
}

/**
 * Assemble the per-key security-level map for one run: container
 * built-ins from {@link CONTAINER_TOOL_LEVELS} (keyed off the tools
 * actually registered this run) plus plugin tools from the host-resolved
 * `context.pluginLevelsByKey`. Keys absent from both (MCP tools, most
 * built-ins) resolve to {@link DEFAULT_TOOL_LEVEL} at lookup time.
 */
function buildLevelsByKey(
    context: ToolsFactoryContext,
    systemTools: ToolSet,
): Map<string, ToolLevel> {
    const levels = new Map<string, ToolLevel>();
    for (const name of Object.keys(systemTools)) {
        const level = CONTAINER_TOOL_LEVELS[name];
        if (level !== undefined) {
            levels.set(name, level);
        }
    }
    if (context.pluginLevelsByKey) {
        for (const [key, level] of context.pluginLevelsByKey) {
            levels.set(key, level);
        }
    }
    if (context.mcpLevelsByKey) {
        for (const [key, level] of context.mcpLevelsByKey) {
            levels.set(key, level);
        }
    }
    return levels;
}

/**
 * The self-contained refusal message for a non-`default` tool invoked
 * by a non-privileged run. Wording differs by level: `privileged` is a
 * hard trust boundary; `approval` is an interim restriction until the
 * approval gate lands.
 */
function toolLevelRefusal(name: string, level: ToolLevel): string {
    if (level === "approval") {
        return (
            `Tool "${name}" requires user approval before running. The approval gate ` +
            "isn't available yet, so for now it only runs in a privileged agentrun " +
            "(one descending from trusted user input, e.g. the cli-chat REPL or an " +
            "allowlisted Telegram sender). This run is non-privileged, so the call was refused."
        );
    }
    return (
        `Tool "${name}" is privileged: it only runs in a privileged agentrun (one ` +
        "descending from trusted user input, e.g. the cli-chat REPL or an allowlisted " +
        "Telegram sender). This run is non-privileged, so the call was refused."
    );
}

/** Clamp a description to `max` chars with a trailing ellipsis. */
function clampDescription(description: string | undefined, max: number): string | undefined {
    if (description === undefined || description.length <= max) {
        return description;
    }
    return `${description.slice(0, max).trimEnd()}…`;
}

/**
 * Rank and select this handler's recently-used tools to auto-load,
 * filling the tool-definition token budget left after the guaranteed
 * set. Candidates come from {@link import("@getfamiliar/shared").ToolCallBus#topToolsForHandler}
 * (most-used first) and are filtered to keys that exist in the pool,
 * aren't already guaranteed, and aren't the meta-tools. Returns `[]`
 * when recording deps are absent or nothing qualifies.
 */
async function selectHeuristicTools(args: {
    context: ToolsFactoryContext;
    allTools: ToolSet;
    guaranteed: ReadonlySet<string>;
}): Promise<string[]> {
    const { context, allTools, guaranteed } = args;
    if (context.toolCallBus === undefined || context.handlerPath === undefined) {
        return [];
    }
    const runWindow = context.toolHeuristicRunWindow ?? DEFAULT_TOOL_HEURISTIC_RUN_WINDOW;
    const ranked = await context.toolCallBus.topToolsForHandler(context.handlerPath, runWindow);
    const candidates = ranked
        .map((r) => r.toolName)
        .filter(
            (name) =>
                allTools[name] !== undefined &&
                !guaranteed.has(name) &&
                name !== TOOL_LIST_KEY &&
                name !== TOOL_CALL_KEY &&
                name !== TOOL_DESCRIBE_KEY,
        );
    if (candidates.length === 0) {
        return [];
    }

    // No context window known → load a fixed number rather than sizing
    // against a budget we can't compute.
    if (context.contextLimit === undefined) {
        return candidates.slice(0, FALLBACK_HEURISTIC_TOOL_CAP);
    }

    const fraction =
        context.toolDefinitionsContextFraction ?? DEFAULT_TOOL_DEFINITIONS_CONTEXT_FRACTION;
    const budgetTokens = Math.floor(context.contextLimit * fraction);
    let remaining = budgetTokens - (await sumDefinitionTokens(guaranteed, allTools));
    const selected: string[] = [];
    for (const name of candidates) {
        const tool = allTools[name];
        if (tool === undefined) {
            continue;
        }
        const cost = await estimateToolDefinitionTokens(name, tool);
        if (cost > remaining) {
            // Skip this one; a smaller lower-ranked tool may still fit.
            continue;
        }
        remaining -= cost;
        selected.push(name);
    }
    return selected;
}

/** Sum the estimated definition-token size of every named tool present in the pool. */
async function sumDefinitionTokens(names: Iterable<string>, pool: ToolSet): Promise<number> {
    let total = 0;
    for (const name of names) {
        const tool = pool[name];
        if (tool !== undefined) {
            total += await estimateToolDefinitionTokens(name, tool);
        }
    }
    return total;
}

/**
 * Estimate the token cost of a tool's model-facing definition —
 * name + description + raw input JSON Schema — via the shared
 * character-based `estimateTokens` heuristic. Schema-read failures
 * degrade to sizing name + description only rather than faulting the
 * build.
 */
async function estimateToolDefinitionTokens(name: string, tool: Tool): Promise<number> {
    let inputSchema: object = {};
    if (tool.inputSchema !== undefined) {
        try {
            inputSchema = await readRawInputSchema(tool);
        } catch {
            inputSchema = {};
        }
    }
    return estimateTokens(
        JSON.stringify({ name, description: tool.description ?? "", inputSchema }),
    );
}

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
