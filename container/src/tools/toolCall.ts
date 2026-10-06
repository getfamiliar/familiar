import type { JSONValue } from "@ai-sdk/provider";
import { ToolError } from "@getfamiliar/shared";
import { jsonSchema, type Tool, type ToolCallOptions, type ToolSet, tool } from "ai";

interface ToolCallInput {
    readonly name: string;
    readonly arguments?: Record<string, unknown>;
}

/** The model-facing rendering of a tool result (the SDK doesn't export the type by name). */
type ToolResultOutput = Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>;

/** How many near-miss suggestions to offer when a name isn't found. */
const SUGGESTION_LIMIT = 8;

/**
 * Build the `tool_call` proxy tool. Invokes any tool in the run's pool
 * by name, including tools not preloaded into the agent's toolset —
 * this is how a handler reaches a capability its `tools:` frontmatter
 * didn't preload. Discover names with `tool_list` first.
 *
 * Dispatch runs against the already-wrapped pool, so the delegated
 * tool's usage is recorded (feeding the heuristic preloader) exactly as
 * a direct call would be — `tool_call` itself adds no separate record
 * and no double count. The SDK-provided call options (abort signal,
 * tool-call id, message history) are forwarded to the delegate so it
 * behaves identically to a direct invocation — including how its result
 * is rendered for the model: the delegate's `toModelOutput` (e.g. the MCP
 * client's, which sends only `content` and drops a duplicated
 * `structuredContent`) is applied to the proxied result too.
 *
 * @param pool The wrapped tool pool (built-ins ∪ MCP ∪ plugin tools).
 */
export function buildToolCallTool(pool: ToolSet): Tool<ToolCallInput, unknown> {
    return tool<ToolCallInput, unknown>({
        description:
            "Invoke any available tool by name, including tools not currently in your toolset. " +
            "Use `tool_list` to discover names first. Pass {name} (the exact tool key) and " +
            "{arguments} (the object that tool expects). The call behaves exactly as if the " +
            "tool were loaded directly.",
        inputSchema: jsonSchema<ToolCallInput>({
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
                name: {
                    type: "string",
                    description: "Exact tool key to invoke (as shown by `tool_list`).",
                },
                arguments: {
                    type: "object",
                    additionalProperties: true,
                    description:
                        "Arguments object passed through to the target tool. Omit for a " +
                        "no-argument tool.",
                },
            },
        }),
        execute: (input, options: ToolCallOptions) => {
            const target = pool[input.name];
            if (target === undefined) {
                throw new ToolError("UnknownTool", unknownToolMessage(input.name, pool));
            }
            if (typeof target.execute !== "function") {
                throw new ToolError(
                    "NotInvokable",
                    `Tool "${input.name}" exists but has no executable implementation.`,
                );
            }
            return target.execute(input.arguments ?? {}, options);
        },
        toModelOutput: ({ toolCallId, input, output }) => {
            const target = pool[input.name];
            if (target?.toModelOutput !== undefined) {
                return target.toModelOutput({
                    toolCallId,
                    input: input.arguments ?? {},
                    output,
                });
            }
            return defaultModelOutput(output);
        },
    });
}

/**
 * The AI SDK's rendering of a tool result for a tool without its own
 * `toModelOutput`: strings as text, everything else as JSON.
 *
 * @param output The raw tool result.
 * @returns The model-facing tool result output.
 */
function defaultModelOutput(output: unknown): ToolResultOutput {
    if (typeof output === "string") {
        return { type: "text", value: output };
    }
    return { type: "json", value: (output ?? null) as JSONValue };
}

/**
 * Compose an error message for an unknown tool name, offering the
 * closest matches (substring, else prefix) so the agent can retry
 * without a separate `tool_list` round-trip. Shared with `tool_describe`
 * so both meta-tools report unknown names identically.
 */
export function unknownToolMessage(name: string, pool: ToolSet): string {
    const needle = name.toLowerCase();
    const keys = Object.keys(pool);
    const suggestions = keys
        .filter((key) => key.toLowerCase().includes(needle) || needle.includes(key.toLowerCase()))
        .slice(0, SUGGESTION_LIMIT);
    const hint =
        suggestions.length > 0
            ? ` Did you mean: ${suggestions.join(", ")}?`
            : " Use `tool_list` to see available tools.";
    return `No tool named "${name}".${hint}`;
}
