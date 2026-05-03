import { type LanguageModel, ToolLoopAgent, type ToolSet } from "ai";

/** Configuration for an {@link AgentRunner}. */
export interface AgentRunnerConfig {
    /** Language model the agent should call (built by ModelFactory). */
    readonly model: LanguageModel;
    /** Tool set the agent may invoke during its loop (built by ToolsFactory). */
    readonly tools: ToolSet;
    /** Optional system prompt. Forwarded as the agent's `instructions`. */
    readonly system?: string;
}

/**
 * Thin wrapper around the Vercel AI SDK's {@link ToolLoopAgent}. Owns one
 * agent instance per runner, so model + tools are configured once and the
 * loop infrastructure is reused across calls.
 *
 * Keeping this wrapper means the rest of the container code (in
 * particular {@link SupervisorWatcher}) is decoupled from the AI SDK and
 * never has to construct provider-specific objects.
 */
export class AgentRunner {
    private readonly agent: ToolLoopAgent<never, ToolSet>;

    constructor(config: AgentRunnerConfig) {
        this.agent = new ToolLoopAgent<never, ToolSet>({
            model: config.model,
            tools: config.tools,
            instructions: config.system,
        });
    }

    /**
     * Run one tool-loop turn against `prompt` and return the model's final
     * text. Errors from the model or any tool invocation propagate
     * unchanged so the caller can decide how to mark the originating event.
     */
    async run(prompt: string): Promise<string> {
        const result = await this.agent.generate({ prompt });
        return result.text;
    }
}
