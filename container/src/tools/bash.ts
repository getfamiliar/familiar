import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
    type AgentRunRow,
    type Logger,
    runTextTool,
    ToolError,
    type ToolRunContext,
} from "@getfamiliar/shared";
import type { Tool } from "ai";
import { jsonSchema, tool } from "ai";
import { optionalEnvInt } from "../env.js";

/**
 * The `bash` tool: run an arbitrary shell command inside the offline agent
 * container. There is no application-level command filtering — the only
 * lines of defence are (a) the container has no network egress and no
 * credentials, and (b) Linux access rights. A privileged agentrun runs the
 * command as the `priv` user (= the host operator's uid, full workspace
 * write); a non-privileged run drops to `unpriv` via `sudo`, which the OS
 * confines to `core.writablePaths` + `/scratch` by directory group
 * permissions. After every command a root pass re-pins ownership/modes so
 * whatever the command created ends up host-owned (see PermissionNormalizer).
 */

interface BashInput {
    readonly command: string;
    readonly intent: string;
    readonly working_directory?: string;
    readonly timeout_ms?: number;
}

/** Default wall-clock timeout when the caller doesn't set `timeout_ms`. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Absolute hard cap on `timeout_ms`, per the tool spec. */
const HARD_CAP_MS = 300_000;
/** Fallback per-step budget (seconds) when `AGENTSTEP_TIMEOUT_SECONDS` is unset. */
const STEP_TIMEOUT_FALLBACK_S = 150;
/**
 * Headroom kept below the per-step timeout. The step timeout aborts the
 * *whole agentrun*; bash's own timer only kills the child and returns
 * control to the handler. Keeping bash's effective ceiling under the step
 * budget means a long command fails gracefully (as a tool result) instead
 * of taking the run down with it.
 */
const STEP_TIMEOUT_MARGIN_MS = 5_000;
/** Per-stream capture cap; oversized output is truncated here (runTextTool also offloads). */
const MAX_CAPTURE_BYTES = 1024 * 1024;
/** Absolute path to the root-only permission-normalizer wrapper (present only in-container). */
const NORMALIZE_WRAPPER = "/usr/local/bin/familiar-normalize";

/**
 * Clamp a requested timeout to the hard cap and the remaining per-step
 * budget, falling back to the default when unset/invalid.
 *
 * @param requested The caller's `timeout_ms`, if any.
 * @returns The effective timeout in milliseconds.
 */
export function clampTimeoutMs(requested: number | undefined): number {
    const stepBudgetMs =
        (optionalEnvInt("AGENTSTEP_TIMEOUT_SECONDS") ?? STEP_TIMEOUT_FALLBACK_S) * 1000;
    const ceiling = Math.max(1_000, Math.min(HARD_CAP_MS, stepBudgetMs - STEP_TIMEOUT_MARGIN_MS));
    const want = typeof requested === "number" && requested > 0 ? requested : DEFAULT_TIMEOUT_MS;
    return Math.min(want, ceiling);
}

/**
 * Build the spawn argv for one command. Privileged runs invoke `bash`
 * directly (the agent process is already `priv`); non-privileged runs drop
 * to `unpriv` via `sudo -n -H` (the agentrunner runs as `priv`, which the
 * sudoers rule lets become `unpriv` without a password; `-H` sets
 * `HOME=/home/unpriv`).
 *
 * @param privileged Whether the agentrun is privileged.
 * @param command The bash command.
 * @returns The executable and its arguments.
 */
export function buildBashArgv(
    privileged: boolean,
    command: string,
): { readonly file: string; readonly args: readonly string[] } {
    if (privileged) {
        return { file: "bash", args: ["-c", command] };
    }
    return { file: "sudo", args: ["-n", "-H", "-u", "unpriv", "bash", "-c", command] };
}

/** Outcome of one captured command run. */
interface BashResult {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly truncated: boolean;
    readonly durationMs: number;
}

/**
 * Resolve the working directory: an explicit absolute path, or the event's
 * scratch dir (`/scratch/<eventId>`, created if missing) by default.
 *
 * @param workingDir The caller's `working_directory`, if any.
 * @param eventId The agentrun's event id.
 * @returns The absolute cwd to run in.
 * @throws {ToolError} If `working_directory` is set but not absolute, or the
 *   default scratch dir can't be created.
 */
function resolveCwd(workingDir: string | undefined, eventId: string): string {
    if (workingDir !== undefined) {
        if (!path.isAbsolute(workingDir)) {
            throw new ToolError(
                "BadWorkingDirectory",
                "working_directory must be an absolute path",
            );
        }
        return workingDir;
    }
    const scratch = path.join("/scratch", eventId);
    try {
        mkdirSync(scratch, { recursive: true });
    } catch (err) {
        throw new ToolError(
            "ScratchUnavailable",
            `could not create event scratch dir ${scratch}: ${(err as Error).message}`,
        );
    }
    return scratch;
}

/**
 * Spawn one command, capturing stdout/stderr (each capped at
 * {@link MAX_CAPTURE_BYTES}) and enforcing the timeout and the runner's
 * abort signal. Never rejects on a non-zero exit — a failed command is a
 * normal result the agent should see; only a spawn failure throws.
 *
 * @param file Executable.
 * @param args Arguments.
 * @param cwd Working directory.
 * @param timeoutMs Effective timeout.
 * @param externalSignal Runner abort signal (step timeout / shutdown).
 * @returns The captured result.
 */
function spawnCapture(
    file: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    externalSignal: AbortSignal | undefined,
): Promise<BashResult> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outBytes = 0;
        let errBytes = 0;
        let truncated = false;
        let timedOut = false;

        const child = spawn(file, [...args], {
            cwd,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout.on("data", (chunk: Buffer) => {
            if (outBytes >= MAX_CAPTURE_BYTES) {
                truncated = true;
                return;
            }
            stdout.push(chunk);
            outBytes += chunk.length;
        });
        child.stderr.on("data", (chunk: Buffer) => {
            if (errBytes >= MAX_CAPTURE_BYTES) {
                truncated = true;
                return;
            }
            stderr.push(chunk);
            errBytes += chunk.length;
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);

        const onAbort = () => child.kill("SIGKILL");
        if (externalSignal !== undefined) {
            if (externalSignal.aborted) {
                child.kill("SIGKILL");
            } else {
                externalSignal.addEventListener("abort", onAbort, { once: true });
            }
        }

        const cleanup = () => {
            clearTimeout(timer);
            externalSignal?.removeEventListener("abort", onAbort);
        };

        child.on("error", (err) => {
            cleanup();
            reject(new ToolError("SpawnFailed", `failed to start command: ${err.message}`));
        });
        child.on("close", (code, signal) => {
            cleanup();
            resolve({
                exitCode: code,
                signal,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
                timedOut,
                truncated,
                durationMs: Date.now() - start,
            });
        });
    });
}

/**
 * Run the root permission-normalizer after a command so anything the
 * command created is re-owned/re-moded to the canonical state. Best-effort
 * and skipped entirely when the wrapper is absent (dev/test outside the
 * container).
 *
 * @param log Optional logger for failures.
 */
function reconcilePermissions(log: Logger | undefined): Promise<void> {
    if (!existsSync(NORMALIZE_WRAPPER)) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const child = spawn("sudo", ["-n", NORMALIZE_WRAPPER], { stdio: "ignore" });
        child.on("error", (err) => {
            log?.warn({ err: err.message }, "bash: permission normalize failed to spawn");
            resolve();
        });
        child.on("close", (code) => {
            if (code !== 0) {
                log?.warn({ code }, "bash: permission normalize exited non-zero");
            }
            resolve();
        });
    });
}

/**
 * Render a {@link BashResult} as the tool's text output: stdout, then a
 * labelled stderr block if any, then a one-line status footer (always
 * present) so the agent can see the exit code / timeout without guessing.
 *
 * @param result The captured result.
 * @returns The text to return to the agent.
 */
function formatResult(result: BashResult): string {
    const parts: string[] = [];
    if (result.stdout.length > 0) {
        parts.push(result.stdout.replace(/\n$/, ""));
    }
    if (result.stderr.length > 0) {
        parts.push(`--- stderr ---\n${result.stderr.replace(/\n$/, "")}`);
    }
    if (result.truncated) {
        parts.push("[output truncated at 1 MiB per stream]");
    }
    if (result.timedOut) {
        parts.push(`[timed out after ${result.durationMs} ms; process killed]`);
    } else if (result.signal !== null) {
        parts.push(`[killed by signal ${result.signal} after ${result.durationMs} ms]`);
    } else {
        parts.push(`[exit code ${result.exitCode ?? 0} in ${result.durationMs} ms]`);
    }
    return parts.join("\n");
}

/**
 * Execute one bash command end to end: resolve cwd, pick the user, run with
 * the clamped timeout, reconcile permissions, log the intent, and return
 * the formatted output.
 */
async function runBash(
    input: BashInput,
    parent: AgentRunRow,
    log: Logger | undefined,
    externalSignal: AbortSignal | undefined,
): Promise<string> {
    if (typeof input.command !== "string" || input.command.trim().length === 0) {
        throw new ToolError("BadCommand", "command must be a non-empty string");
    }
    const cwd = resolveCwd(input.working_directory, parent.eventId);
    const timeoutMs = clampTimeoutMs(input.timeout_ms);
    const { file, args } = buildBashArgv(parent.privileged, input.command);

    let result: BashResult;
    try {
        result = await spawnCapture(file, args, cwd, timeoutMs, externalSignal);
    } finally {
        await reconcilePermissions(log);
    }

    log?.info(
        {
            intent: input.intent,
            user: parent.privileged ? "priv" : "unpriv",
            cwd,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
        },
        `bash (${parent.privileged ? "priv" : "unpriv"}): ${input.intent}`,
    );

    return formatResult(result);
}

/**
 * Build the `bash` tool for one agentrun. Lives in its own opt-in `bash`
 * tool group (see `CONTAINER_TOOL_GROUPS`), so a handler only gets it via
 * `tools: bash` (or `tools: all`).
 *
 * @param parent The running agentrun (decides priv vs. unpriv, default cwd).
 * @param ctx Tool run context (output offloading).
 * @param log Optional logger for the per-command audit line.
 * @returns The AI SDK tool.
 */
export function buildBashTool(
    parent: AgentRunRow,
    ctx: ToolRunContext,
    log?: Logger,
): Tool<BashInput, string> {
    return tool<BashInput, string>({
        description:
            "Execute a bash command. Each call is a fresh `bash -c` shell — no state (cwd, env, " +
            "variables) persists between calls. Use absolute paths or set working_directory. " +
            "Output is the command's combined stdout/stderr plus an exit-code footer.",
        inputSchema: jsonSchema<BashInput>({
            type: "object",
            additionalProperties: false,
            required: ["command", "intent"],
            properties: {
                command: {
                    type: "string",
                    description:
                        "The bash command to execute. Use && to chain, quote carefully, prefer " +
                        "absolute paths.",
                },
                intent: {
                    type: "string",
                    description:
                        "One sentence: what this command is supposed to accomplish. Used for logs " +
                        "and approval prompts.",
                },
                working_directory: {
                    type: "string",
                    description:
                        "Absolute path. Defaults to the current event's scratch dir " +
                        "(/scratch/<event-id>).",
                },
                timeout_ms: {
                    type: "number",
                    description:
                        "Wall-clock timeout in milliseconds. Default 30000, hard cap 300000 " +
                        "(further bounded by the per-step budget). On timeout the process is " +
                        "killed and control returns to you.",
                },
            },
        }),
        execute: (input, options) =>
            runTextTool(() => runBash(input, parent, log, options?.abortSignal), ctx),
    });
}
