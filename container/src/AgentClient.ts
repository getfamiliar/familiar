import { spawn } from "node:child_process";
import type { ExecuteResult } from "effective-assistant-shared";

const WORKSPACE_CONTEXT = "/workspace/context";

/** JSON output structure from `claude -p --output-format json`. */
interface ClaudeJsonOutput {
    session_id: string;
    result: string;
    is_error: boolean;
}

/**
 * Wraps the Claude CLI in headless mode (`claude -p`).
 * Manages session resumption and provides a clean execute interface.
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
     * Execute a prompt via the Claude CLI in print mode.
     * If a session ID is known (from constructor or a previous execute call),
     * the session is automatically resumed.
     *
     * @param prompt - The prompt to send to the agent.
     * @returns The session ID and result text.
     * @throws On CLI errors or non-zero exit codes.
     */
    async execute(prompt: string): Promise<ExecuteResult> {
        const args = ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions"];

        if (this.sessionId) {
            args.push("--resume", this.sessionId);
        }

        const result = await this.spawnClaude(args);
        const parsed: ClaudeJsonOutput = JSON.parse(result);

        if (parsed.is_error) {
            throw new Error(`Claude error: ${parsed.result}`);
        }

        this.sessionId = parsed.session_id;

        return { sessionId: parsed.session_id, result: parsed.result };
    }

    /**
     * Spawn the `claude` CLI and collect its stdout output.
     * Stderr is passed through to the parent process for logging.
     *
     * @param args - CLI arguments to pass to `claude`.
     * @returns The full stdout output as a string.
     * @throws If the process exits with a non-zero code.
     */
    private spawnClaude(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn("claude", args, {
                cwd: WORKSPACE_CONTEXT,
                stdio: ["ignore", "pipe", "inherit"],
            });

            let stdout = "";
            proc.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
            });

            proc.on("close", (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(`claude exited with code ${code}: ${stdout}`));
                }
            });

            proc.on("error", (err) => {
                reject(new Error(`Failed to spawn claude: ${err.message}`));
            });
        });
    }
}
