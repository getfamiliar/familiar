import type { ToolSet } from "ai";
import type { ChatManager } from "../chat/ChatManager";
import { buildDoneTool } from "./done";
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
 * Two categories of tools:
 *
 * - **System tools** (`send_chat`, `done`) are owned by the agent
 *   runtime and ALWAYS registered, regardless of the handler's
 *   `allowedTools` filter. `done` is the loop terminator (no execute);
 *   `send_chat` is how the agent reaches the user. Without these the
 *   agent can't function.
 * - **Handler tools** (future: bus-state MCP, file-system MCP, plugin
 *   MCPs) are filtered by `allowedTools` in the handler's YAML header.
 *   None registered yet.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Reserved as a growth point for tool registration.
export class ToolsFactory {
    /**
     * Build the tool set for one agentrun. System tools are always
     * present; the handler's `allowedTools` filter only narrows
     * non-system tools.
     */
    static build(context: ToolsFactoryContext = {}): ToolSet {
        const systemTools: ToolSet = {
            done: buildDoneTool(),
        };
        if (context.chat && context.eventId) {
            systemTools.send_chat = buildSendChatTool(context.chat, context.eventId);
        }

        const handlerTools: ToolSet = {};
        // (No handler-controlled tools registered yet.)

        if (!context.allowed || context.allowed.length === 0) {
            return { ...handlerTools, ...systemTools };
        }
        const filtered: ToolSet = {};
        for (const name of context.allowed) {
            if (handlerTools[name]) {
                filtered[name] = handlerTools[name];
            }
        }
        return { ...filtered, ...systemTools };
    }
}
