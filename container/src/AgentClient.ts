import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const WORKSPACE_CONTEXT = "/workspace/context";

/** Callback invoked for each event emitted by the SDK. */
export type StreamEventHandler = (event: SDKMessage) => void;

/** Aggregate figures captured from the terminal `result` message. */
export interface ExecuteSummary {
    readonly durationMs: number;
    readonly durationApiMs: number;
    readonly numTurns: number;
    readonly totalCostUsd: number;
    readonly isError: boolean;
}

/** Result of a single `AgentClient.execute` call. */
export interface ExecuteResult {
    readonly sessionId: string;
    readonly result: string;
    readonly summary: ExecuteSummary;
}

/**
 * Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` for our agent
 * container. Streams every SDK message to an optional callback, captures
 * the terminal `result` message, and exposes a clean execute interface.
 */
export class AgentClient {
    private sessionId: string | undefined;

    /**
     * @param sessionId - Optional session ID to resume a previous conversation.
     */
    constructor(sessionId?: string) {
        this.sessionId = sessionId;
    }

    /**
     * Execute a prompt via the Agent SDK. If a session ID is known (from
     * the constructor or a previous call), the session is resumed.
     *
     * @param prompt - The prompt to send to the agent.
     * @param onEvent - Optional callback invoked for every emitted message.
     * @returns The session ID, final assistant text, and summary.
     * @throws If the SDK reports an error result or no result message.
     */
    async execute(prompt: string, onEvent?: StreamEventHandler): Promise<ExecuteResult> {
        const iterator = query({
            prompt,
            options: {
                cwd: WORKSPACE_CONTEXT,
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                pathToClaudeCodeExecutable: "/usr/local/bin/claude",
                model: "claude-haiku-4-5",
                ...(this.sessionId ? { resume: this.sessionId } : {}),
            },
        });

        let resultMessage: SDKMessage | undefined;
        for await (const message of iterator) {
            onEvent?.(message);
            if (message.type === "result") {
                resultMessage = message;
            }
        }

        if (!resultMessage || resultMessage.type !== "result") {
            throw new Error("Agent SDK exited without emitting a result message");
        }

        if (resultMessage.is_error) {
            const detail =
                resultMessage.subtype === "success"
                    ? (resultMessage.result ?? "no result text")
                    : resultMessage.errors.join("; ");
            throw new Error(`Agent error (${resultMessage.subtype}): ${detail}`);
        }

        this.sessionId = resultMessage.session_id;
        const text = resultMessage.subtype === "success" ? resultMessage.result : "";

        return {
            sessionId: resultMessage.session_id,
            result: text,
            summary: {
                durationMs: resultMessage.duration_ms,
                durationApiMs: resultMessage.duration_api_ms,
                numTurns: resultMessage.num_turns,
                totalCostUsd: resultMessage.total_cost_usd,
                isError: resultMessage.is_error,
            },
        };
    }
}
