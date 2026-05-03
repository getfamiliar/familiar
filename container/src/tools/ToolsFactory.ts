import type { ToolSet } from "ai";

/**
 * Builds the tool set the {@link AgentRunner} hands to the Vercel AI SDK's
 * tool-loop agent. Empty for now — the smoke wiring just needs the model
 * to produce text. Real tools (bus-state MCP, file-system MCP, plugin
 * MCPs) plug in here once the MCP gateway is online.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Reserved as a growth point for tool registration.
export class ToolsFactory {
    /** Build the supervisor's tool set. */
    static build(): ToolSet {
        return {};
    }
}
