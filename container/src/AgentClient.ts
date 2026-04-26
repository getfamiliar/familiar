import { spawn } from "node:child_process";
import type {
    ExecuteResult,
    RateLimitEvent,
    ResultEvent,
    StreamEvent,
} from "effective-assistant-shared";

const WORKSPACE_CONTEXT = "/workspace/context";

/** Callback invoked for each event emitted on the stream-json channel. */
export type StreamEventHandler = (event: StreamEvent) => void;

/**
 * Wraps the Claude CLI in headless mode (`claude -p --output-format stream-json`).
 * Manages session resumption, parses the JSONL event stream, and exposes a
 * clean execute interface that returns the full event trace plus a summary
 * of the run's duration/cost/token usage.
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
     * Execute a prompt via the Claude CLI in print mode with stream-json
     * output. If a session ID is known (from constructor or a previous
     * execute call), the session is automatically resumed.
     *
     * @param prompt - The prompt to send to the agent.
     * @param onEvent - Optional callback invoked for every emitted event.
     * @returns The session ID, final text, full event trace, and summary.
     * @throws If the CLI reports `is_error`, no terminal `result` event was emitted, or the process fails to spawn.
     */
    async execute(prompt: string, onEvent?: StreamEventHandler): Promise<ExecuteResult> {
        const args = [
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--dangerously-skip-permissions",
        ];

        if (this.sessionId) {
            args.push("--resume", this.sessionId);
        }

        const events: StreamEvent[] = [];
        const exitCode = await this.spawnClaudeStreaming(args, (event) => {
            events.push(event);
            onEvent?.(event);
        });

        const resultEvent = events.find((event): event is ResultEvent => event.type === "result");

        if (!resultEvent) {
            throw new Error(`claude exited with code ${exitCode} without emitting a result event`);
        }

        if (resultEvent.is_error) {
            throw new Error(
                `Claude error (${resultEvent.subtype}): ${resultEvent.result ?? "no result text"}`,
            );
        }

        this.sessionId = resultEvent.session_id;

        const lastRateLimit = events
            .filter((event): event is RateLimitEvent => event.type === "rate_limit_event")
            .at(-1);

        return {
            sessionId: resultEvent.session_id,
            result: resultEvent.result ?? "",
            events,
            summary: {
                durationMs: resultEvent.duration_ms,
                durationApiMs: resultEvent.duration_api_ms,
                numTurns: resultEvent.num_turns,
                totalCostUsd: resultEvent.total_cost_usd,
                usage: resultEvent.usage,
                isError: resultEvent.is_error,
                ...(lastRateLimit ? { rateLimit: lastRateLimit.rate_limit_info } : {}),
            },
        };
    }

    /**
     * Spawn the `claude` CLI and parse its stdout as newline-delimited JSON
     * events. Each complete line is JSON-parsed and passed to `onEvent`.
     * Stderr is passed through to the parent process for logging.
     *
     * Resolves on any clean exit (including non-zero codes) so the caller
     * can inspect the terminal `result` event — the CLI reports application
     * errors (auth failures, max turns, etc.) via that event while exiting
     * with a non-zero code. Only spawn/parse failures reject.
     *
     * @param args - CLI arguments to pass to `claude`.
     * @param onEvent - Callback invoked for every parsed event.
     * @returns The process exit code, or `null` if the process was signalled.
     * @throws If the process fails to spawn or a line cannot be parsed.
     */
    private spawnClaudeStreaming(
        args: string[],
        onEvent: StreamEventHandler,
    ): Promise<number | null> {
        return new Promise((resolve, reject) => {
            const proc = spawn("claude", args, {
                cwd: WORKSPACE_CONTEXT,
                stdio: ["ignore", "pipe", "inherit"],
            });

            let buffer = "";
            let parseError: Error | undefined;

            proc.stdout.on("data", (chunk: Buffer) => {
                buffer += chunk.toString();
                let newlineIndex = buffer.indexOf("\n");
                while (newlineIndex !== -1) {
                    const line = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);
                    if (line.length > 0) {
                        try {
                            const event = JSON.parse(line) as StreamEvent;
                            onEvent(event);
                        } catch (err) {
                            parseError = new Error(
                                `Failed to parse claude stream line: ${(err as Error).message} (line: ${line.slice(0, 200)})`,
                            );
                            proc.kill();
                            return;
                        }
                    }
                    newlineIndex = buffer.indexOf("\n");
                }
            });

            proc.on("close", (code) => {
                if (parseError) {
                    reject(parseError);
                    return;
                }

                const tail = buffer.trim();
                if (tail.length > 0) {
                    try {
                        const event = JSON.parse(tail) as StreamEvent;
                        onEvent(event);
                    } catch (err) {
                        reject(
                            new Error(
                                `Failed to parse trailing claude stream line: ${(err as Error).message}`,
                            ),
                        );
                        return;
                    }
                }

                resolve(code);
            });

            proc.on("error", (err) => {
                reject(new Error(`Failed to spawn claude: ${err.message}`));
            });
        });
    }
}
