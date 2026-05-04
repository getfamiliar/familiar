import type { ToolSet } from "ai";
import type { ChatManager } from "../chat/ChatManager";
import { buildSendChatTool } from "./sendChat";

/** Inputs the {@link AgentRunner} threads into the factory per agentrun. */
export interface ToolsFactoryContext {
    /** Chat history facade. When omitted, the `send_chat` tool is not registered. */
    readonly chat?: ChatManager;
    /** Parent event id for the running agentrun; closed over by chat-aware tools. */
    readonly eventId?: string;
    /** Tool ids the handler is permitted to call (from its YAML header). */
    readonly allowed?: readonly string[];
}

/**
 * Builds the tool set the {@link import("../agent-runner/AgentRunner").AgentRunner}
 * hands to the Vercel AI SDK's tool-loop agent.
 *
 * Currently registers only `send_chat`; real plugin tools (bus-state
 * MCP, file-system MCP, plugin MCPs) plug in here once the MCP gateway
 * is online.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Reserved as a growth point for tool registration.
export class ToolsFactory {
    /**
     * Build the tool set for one agentrun. The handler's `allowedTools`
     * filter is honored when set; an empty/undefined filter exposes
     * every registered tool.
     */
    static build(context: ToolsFactoryContext = {}): ToolSet {
        const tools: ToolSet = {};

        if (context.chat && context.eventId) {
            tools.send_chat = buildSendChatTool(context.chat, context.eventId);
        }

        if (!context.allowed || context.allowed.length === 0) {
            return tools;
        }
        const filtered: ToolSet = {};
        for (const name of context.allowed) {
            if (tools[name]) {
                filtered[name] = tools[name];
            }
        }
        return filtered;
    }
}
