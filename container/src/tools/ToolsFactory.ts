import type { AgentRunBus, AgentRunRow, Logger } from "@getfamiliar/shared";
import type { ToolSet } from "ai";
import type { ChatManager } from "../chat/ChatManager.js";
import { buildCallHandlerTool, type WaitForSubagent } from "./callHandler.js";
import { buildFsTools } from "./fs.js";
import { buildQueueHandlerTool } from "./queueHandler.js";
import { buildSendChatTool } from "./sendChat.js";
import {
    evaluate,
    type GroupLookup,
    MCP_GROUP_NAME,
    parseExpression,
    SYSTEM_GROUP_NAME,
} from "./ToolFilter.js";

/** Inputs the {@link AgentRunner} threads into the factory per agentrun. */
export interface ToolsFactoryContext {
    /** Chat history facade. When omitted, the `send_chat` tool is not registered. */
    readonly chat?: Pick<ChatManager, "fetchHistory" | "appendAssistantMessage">;
    /** Parent event id for the running agentrun; closed over by chat-aware tools. */
    readonly eventId?: string;
    /**
     * Tool-filter expression from the handler's `tools:` header.
     * When `undefined`, the implicit default `system` is used (every
     * registered system tool, no MCP tools). See `tools/ToolFilter.ts`
     * for the full grammar and built-in groups.
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
    /** Agentrun bus; required to register `queue_handler` / `call_handler`. */
    readonly bus?: AgentRunBus;
    /**
     * The currently-running agentrun row; closed over by both
     * `queue_handler` and `call_handler` for parent inheritance.
     */
    readonly parent?: AgentRunRow;
    /**
     * Scheduler-provided callback that, given a freshly-inserted
     * child agentrun id, suspends the parent until the child settles
     * and resolves with the child's terminal row. When supplied (and
     * `bus` + `parent` are also present), `call_handler` is registered;
     * without it, only `queue_handler` is available.
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
     * file. Reserved names (`all`, `system`, `mcp`, `none`) cannot
     * appear as keys because the host's `mcp.yml` linter rejects
     * them as ids.
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
 * **One pool, one filter.** System tools (`send_chat`,
 * `queue_handler`, `call_handler`, `file_*`, `fs_*`) and MCP tools
 * (`${id}_${name}`) are merged into a single available set. The
 * handler's `tools:` expression — or, when omitted, the implicit
 * `system` default — decides what survives.
 *
 * Built-in groups visible from any expression:
 *
 * - `all` — every key in the available pool.
 * - `system` — just the system-tool keys registered for *this*
 *   agentrun. Conditional registrations (`send_chat` only when chat
 *   context is present, `queue_handler` / `call_handler` only when
 *   bus + parent are present, with `call_handler` further requiring
 *   the Scheduler's `waitForSubagent` callback) are reflected here
 *   automatically.
 * - `mcp` — just the MCP-tool keys.
 * - `none` — empty set; lets a child handler override its parent's
 *   `tools:` to nothing under the replace-merge rule.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Reserved as a growth point for tool registration.
export class ToolsFactory {
    /**
     * Build the tool set for one agentrun. Fully evaluates the
     * `tools:` expression (or the `system` default) against the
     * unified system+MCP pool and returns the projected `ToolSet`.
     */
    static build(context: ToolsFactoryContext = {}): ToolSet {
        const systemTools: ToolSet = {};
        if (context.chat && context.eventId) {
            systemTools.send_chat = buildSendChatTool(context.chat, context.eventId);
        }
        if (context.bus && context.parent) {
            systemTools.queue_handler = buildQueueHandlerTool(context.bus, context.parent);
            if (context.waitForSubagent) {
                systemTools.call_handler = buildCallHandlerTool(
                    context.bus,
                    context.parent,
                    context.waitForSubagent,
                );
            }
        }
        if (context.parent) {
            // Filesystem tools are always available; the writing tools
            // (file_write / file_str_replace / file_append) consult
            // `parent.privileged` internally to gate `.md` paths and
            // anything under `workspace/toolgroups/`, so every agentrun
            // can read but only privileged runs can modify those.
            Object.assign(systemTools, buildFsTools(context.parent));
        }

        const mcpTools = context.mcpTools ?? {};
        const pluginTools = context.pluginTools ?? {};
        const allTools: ToolSet = { ...systemTools, ...mcpTools, ...pluginTools };
        const systemKeys = new Set(Object.keys(systemTools));
        const mcpKeys = new Set(Object.keys(mcpTools));
        const availableKeys = new Set(Object.keys(allTools));

        const matched = resolveMatched({
            available: availableKeys,
            systemKeys,
            mcpKeys,
            mcpKeysById: context.mcpKeysById,
            pluginKeysById: context.pluginKeysById,
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
 * - `tools:` undefined ⇒ implicit `system` (every system-tool key).
 * - `tools:` set ⇒ parse the expression and evaluate against the
 *   unified pool. The `system` and `mcp` built-ins are supplied via
 *   the `builtins` map; `all` and `none` are handled by the
 *   evaluator from `available`.
 */
function resolveMatched(args: {
    available: ReadonlySet<string>;
    systemKeys: ReadonlySet<string>;
    mcpKeys: ReadonlySet<string>;
    mcpKeysById: ReadonlyMap<string, ReadonlySet<string>> | undefined;
    pluginKeysById: ReadonlyMap<string, ReadonlySet<string>> | undefined;
    toolsExpression: string | undefined;
    lookup: GroupLookup | undefined;
}): Set<string> {
    if (args.toolsExpression === undefined || args.toolsExpression.trim().length === 0) {
        return new Set(args.systemKeys);
    }
    const ast = parseExpression(args.toolsExpression);
    // Per-MCP and per-plugin entries land first; `system` and `mcp`
    // are written afterwards so they win on the (lint-prevented)
    // chance of a sanitized id colliding with a reserved name.
    // `all` and `none` are short-circuited by the evaluator before
    // any builtins lookup. The plugin registry guarantees plugin
    // ids do not collide with MCP ids, so the two id maps can be
    // merged unconditionally.
    const builtins = new Map<string, ReadonlySet<string>>();
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
    builtins.set(SYSTEM_GROUP_NAME, args.systemKeys);
    builtins.set(MCP_GROUP_NAME, args.mcpKeys);
    const lookup = args.lookup ?? rejectAnyLookup;
    return evaluate(ast, args.available, lookup, builtins);
}

/**
 * Default lookup used when no group-loader was wired in (tests,
 * future call sites). Always resolves to "no such group" — the
 * resolver translates that to `unknown group: <name>`.
 */
const rejectAnyLookup: GroupLookup = () => undefined;
