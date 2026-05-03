import { ToolLoopAgent, type ToolSet } from "ai";
import type { AgentRunRow } from "effective-assistant-shared";
import { HandlerFile } from "../HandlerFile";
import { ModelFactory } from "../models/ModelFactory";
import { PromptBuilder } from "../PromptBuilder";
import { ToolsFactory } from "../tools/ToolsFactory";

/**
 * One-shot runner for a single agentrun row.
 *
 * Construction is cheap and per-row by design: the runner reads the
 * handler markdown, builds a {@link ToolLoopAgent} configured from the
 * file's YAML header, runs it once, and is then thrown away. The
 * underlying `ToolLoopAgent` is itself a lightweight settings holder;
 * the heavier work (HTTP client, provider config) lives on the
 * `LanguageModel` returned by {@link ModelFactory.build}, which can be
 * cached behind that factory once a hot path emerges.
 *
 * Call site: {@link AgentrunWatcher.handle} does
 * `await new AgentRunner(row).run()` per claimed agentrun.
 */
export class AgentRunner {
    private readonly row: AgentRunRow;

    constructor(row: AgentRunRow) {
        this.row = row;
    }

    /**
     * Resolve and parse the handler markdown for this agentrun, build a
     * {@link ToolLoopAgent} per the parsed header (model, temperature,
     * allowedTools), and run it once. Returns the agent's final text.
     *
     * The handler body is passed as the agent's `instructions` (system
     * prompt). The per-call user prompt is derived from the agentrun's
     * `prompt` and `payload` fields.
     *
     * @throws If the handler file is missing or malformed, the model
     *   cannot be constructed (e.g. unset env vars), or the agent loop
     *   itself fails.
     */
    async run(): Promise<string> {
        const handler = HandlerFile.load(this.row.topic, this.row.handler);
        const model = ModelFactory.build(handler.header.model);
        const tools = ToolsFactory.build(handler.header.allowedTools);
        const toolNames = Object.keys(tools);

        const agent = new ToolLoopAgent<never, ToolSet>({
            model,
            tools,
            instructions: PromptBuilder.buildSystem(handler.body, toolNames),
            temperature: handler.header.temperature,
        });

        const prompt = PromptBuilder.buildPrompt(this.row.prompt, this.row.payload);
        const result = await agent.generate({ prompt });
        return result.text;
    }
}
