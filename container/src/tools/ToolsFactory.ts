import type { ToolSet } from "ai";
import type { AgentRunBus, AgentRunRow } from "effective-assistant-shared";
import type { ChatManager } from "../chat/ChatManager.js";
import { buildGetWeatherTool } from "./getWeather.js";
import { buildQueueRunTool } from "./queueRun.js";
import { buildSendChatTool } from "./sendChat.js";

/** Inputs the {@link AgentRunner} threads into the factory per agentrun. */
export interface ToolsFactoryContext {
    /** Chat history facade. When omitted, the `send_chat` tool is not registered. */
    readonly chat?: ChatManager;
    /** Parent event id for the running agentrun; closed over by chat-aware tools. */
    readonly eventId?: string;
    /** Tool ids the handler is permitted to call (from its YAML header). */
    readonly allowed?: readonly string[];
    /** Agentrun bus; required to register `queue_run`. */
    readonly bus?: AgentRunBus;
    /** The currently-running agentrun row; closed over by `queue_run`. */
    readonly parent?: AgentRunRow;
}

/**
 * Builds the tool set the {@link import("../agent-runner/AgentRunner").AgentRunner}
 * hands to the Vercel AI SDK's tool-loop agent.
 *
 * Two categories of tools:
 *
 * - **System tools** (`send_chat`) are owned by the agent runtime
 *   and ALWAYS registered. `send_chat` is how the agent reaches the
 *   user; without it chat handlers can't function.
 * - **Probe / handler tools** (currently `get_weather`) are utility
 *   tools used to exercise tool-calling. The `allowedTools` filter
 *   would normally narrow these per-handler; for the moment we
 *   register `get_weather` unconditionally so any handler can pick
 *   it up while we measure tool-call reliability across providers.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Reserved as a growth point for tool registration.
export class ToolsFactory {
    /**
     * Build the tool set for one agentrun. System tools are always
     * present; the handler's `allowedTools` filter only narrows
     * non-system tools (none of which exist yet).
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
