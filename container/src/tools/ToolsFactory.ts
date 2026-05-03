import type { ToolSet } from "ai";

/**
 * Builds the tool set the {@link AgentRunner} hands to the Vercel AI SDK's
 * tool-loop agent. Empty for now — the smoke wiring just needs the model
 * to produce text. Real tools (bus-state MCP, file-system MCP, plugin
 * MCPs) plug in here once the MCP gateway is online.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Reserved as a growth point for tool registration.
export class ToolsFactory {
    /**
     * Build the tool set for one agentrun, optionally filtered by the
     * `allowedTools` declared in the handler's YAML header.
     *
     * @param allowed Tool ids the handler is permitted to call.
     *   Currently a no-op — no tools are registered yet, so the filter
     *   has nothing to filter. Will start being honored once the bus-
     *   state and file-system MCPs are wired up.
     */
    static build(allowed?: readonly string[]): ToolSet {
        void allowed;
        return {};
    }
}
