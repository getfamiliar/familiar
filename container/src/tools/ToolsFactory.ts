import type { ToolSet } from "ai";
import type { AgentRunBus, AgentRunRow, Logger } from "effective-assistant-shared";
import type { ChatManager } from "../chat/ChatManager.js";
import { buildFsTools } from "./fs.js";
import { buildGetWeatherTool } from "./getWeather.js";
import { buildQueueRunTool } from "./queueRun.js";
import { buildSendChatTool } from "./sendChat.js";
import { evaluate, type GroupDef, parseExpression } from "./ToolFilter.js";

/** Inputs the {@link AgentRunner} threads into the factory per agentrun. */
export interface ToolsFactoryContext {
    /** Chat history facade. When omitted, the `send_chat` tool is not registered. */
    readonly chat?: ChatManager;
    /** Parent event id for the running agentrun; closed over by chat-aware tools. */
    readonly eventId?: string;
    /**
     * Tool-filter expression from the handler's `tools:` header. When
     * `undefined`, **no MCP tools** are exposed (system tools still
     * present). See `tools/ToolFilter.ts` for grammar.
     */
    readonly toolsExpression?: string;
    /**
     * Loaded group definitions (one per `workspace/toolgroups/*.txt`).
     * Empty map is fine; the built-in `all` group is resolved by the
     * evaluator regardless of map contents.
     */
    readonly groups?: ReadonlyMap<string, GroupDef>;
    /** Agentrun bus; required to register `queue_run`. */
    readonly bus?: AgentRunBus;
    /** The currently-running agentrun row; closed over by `queue_run`. */
    readonly parent?: AgentRunRow;
    /**
     * MCP-derived tools, namespaced as `${id}_${toolName}` by the
     * {@link McpClientPool}. Filtered by the handler's `tools:`
     * expression before being merged with system tools.
     */
    readonly mcpTools?: ToolSet;
    /**
     * Logger child for filter diagnostics (unknown paths, empty
     * matches). Resolution errors throw so the agentrun fails loud;
     * warnings stay non-fatal.
     */
    readonly log?: Logger;
}

/**
 * Builds the tool set the {@link import("../agent-runner/AgentRunner").AgentRunner}
 * hands to the Vercel AI SDK's tool-loop agent.
 *
 * Two categories of tools:
 *
 * - **System tools** (`send_chat`, `queue_run`, filesystem,
 *   `get_weather`) are owned by the agent runtime and ALWAYS
 *   registered. `send_chat` is how the agent reaches the user;
 *   without it chat handlers can't function.
 * - **Handler tools** (currently MCP tools from
 *   {@link McpClientPool}) are filtered through the handler's
 *   `tools:` expression. When the expression is omitted, NO MCP
 *   tools are exposed — every handler opts in explicitly. The
 *   built-in group `all` is the escape hatch for handlers that
 *   genuinely want everything.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Reserved as a growth point for tool registration.
export class ToolsFactory {
    /**
     * Build the tool set for one agentrun. System tools are always
     * present; the handler's `tools:` expression filters MCP tools.
     */
    static build(context: ToolsFactoryContext = {}): ToolSet {
        const systemTools: ToolSet = {
            get_weather: buildGetWeatherTool(),
        };
        if (context.chat && context.eventId) {
            systemTools.send_chat = buildSendChatTool(context.chat, context.eventId);
        }
        if (context.bus && context.parent) {
            systemTools.queue_run = buildQueueRunTool(context.bus, context.parent);
        }
        if (context.parent) {
            // Filesystem tools are always available; the writing tools
            // (file_write / file_str_replace / file_append) consult
            // `parent.privileged` internally to gate `.md` paths and
            // anything under `workspace/toolgroups/`, so every agentrun
            // can read but only privileged runs can modify those.
            Object.assign(systemTools, buildFsTools(context.parent));
        }

        const filteredMcpTools = filterMcpTools(
            context.mcpTools ?? {},
            context.toolsExpression,
            context.groups,
        );
        return { ...filteredMcpTools, ...systemTools };
    }
}

/**
 * Apply the handler's `tools:` expression to the pool's full MCP tool
 * set. Returns the projected `ToolSet`. Resolution errors (bad syntax,
 * unknown group, group cycle) propagate to the caller so the agentrun
 * fails before the model is invoked.
 */
function filterMcpTools(
    mcpTools: ToolSet,
    expression: string | undefined,
    groups: ReadonlyMap<string, GroupDef> | undefined,
): ToolSet {
    if (expression === undefined || expression.trim().length === 0) {
        return {};
    }
    const ast = parseExpression(expression);
    const available = new Set(Object.keys(mcpTools));
    const matched = evaluate(ast, available, groups ?? new Map());
    const out: ToolSet = {};
    for (const name of matched) {
        const tool = mcpTools[name];
        if (tool !== undefined) {
            out[name] = tool;
        }
    }
    return out;
}
