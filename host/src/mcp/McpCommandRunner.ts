import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { maskSecretSlice } from "../config/SecretOutputMasking.js";
import { dockerExec } from "../utils/DockerTools.js";

/** Container-name prefix of one-shot calls, distinct from the bastion's `familiar-mcp-<id>`. */
export const MCP_EXEC_CONTAINER_PREFIX = "familiar-mcp-exec-";

/** Default hard runtime cap of one call (15 minutes). */
export const DEFAULT_MAX_RUNTIME_MS = 15 * 60 * 1000;

/** Default retention of a finished call whose final output was never read (1 hour). */
export const DEFAULT_RETENTION_MS = 60 * 60 * 1000;

/** Default cap of buffered output per call; older output is dropped first. */
export const DEFAULT_MAX_BUFFER_CHARS = 1024 * 1024;

/** How long {@link McpCommandRunner.stop} waits for the process to go away. */
const STOP_GRACE_MS = 10_000;

/** Starts and kills the processes of one-shot calls; injectable for tests. */
export interface McpCommandSpawner {
    /**
     * Start the process for one call.
     *
     * @param argv The docker argv (without the leading `docker`).
     * @returns The child process with piped stdio.
     */
    spawn(argv: readonly string[]): ChildProcess;
    /**
     * Remove the call's container. Killing the docker CLI alone does not
     * stop it.
     *
     * @param containerName The `--name` of the call's container.
     */
    kill(containerName: string): Promise<void>;
}

/** The default spawner: the docker CLI. */
const DOCKER_SPAWNER: McpCommandSpawner = {
    spawn: (argv) => spawn("docker", [...argv], { stdio: ["pipe", "pipe", "pipe"] }),
    kill: (containerName) => dockerExec(["rm", "-f", containerName], { allowFailure: true }),
};

/** Options of {@link McpCommandRunner}. */
export interface McpCommandRunnerOptions {
    readonly spawner?: McpCommandSpawner;
    readonly maxRuntimeMs?: number;
    readonly retentionMs?: number;
    readonly maxBufferChars?: number;
}

/** What one read of a call returns to the agent. */
export interface McpCommandReadResult {
    readonly callId: string;
    /** Whether the process is still running (poll again with the `callId`). */
    readonly running: boolean;
    /** Exit code once finished; `null` while running or when killed by a signal. */
    readonly exitCode: number | null;
    /** Output (stdout and stderr interleaved) new since the last read, secrets masked. */
    readonly output: string;
    /** Whether output was dropped because the buffer cap was exceeded before it was read. */
    readonly outputTruncated: boolean;
    /** Whether the call was killed for exceeding the runtime cap. */
    readonly timedOut: boolean;
}

/** Thrown for an unknown or expired call id. */
export class UnknownMcpCallError extends Error {
    constructor(callId: string) {
        super(
            `no running or unread call "${callId}" (finished calls are dropped after their final output was read)`,
        );
        this.name = "UnknownMcpCallError";
    }
}

/** State of one call. */
interface McpCall {
    readonly callId: string;
    readonly mcpId: string;
    readonly containerName: string;
    readonly process: ChildProcess;
    readonly exited: Promise<void>;
    readonly runtimeTimer: NodeJS.Timeout;
    raw: string;
    releasedTo: number;
    isOutputTruncated: boolean;
    isRunning: boolean;
    isTimedOut: boolean;
    exitCode: number | null;
    finishedAt: number | null;
}

/**
 * Runs one-shot commands in MCP runtime containers on the agent's behalf
 * (`mcp_execute_bash_command`) and keeps them alive across tool calls:
 * a call that hasn't exited within the caller's wait returns its output
 * so far (e.g. a device-code login prompt) and keeps running; later
 * reads by `callId` deliver the rest. Output is masked on release, never
 * stored masked, so a secret entered while the call runs is covered too.
 *
 * One instance per daemon; {@link stopAll} on shutdown.
 */
export class McpCommandRunner {
    private readonly calls = new Map<string, McpCall>();
    private readonly spawner: McpCommandSpawner;
    private readonly maxRuntimeMs: number;
    private readonly retentionMs: number;
    private readonly maxBufferChars: number;

    constructor(options: McpCommandRunnerOptions = {}) {
        this.spawner = options.spawner ?? DOCKER_SPAWNER;
        this.maxRuntimeMs = options.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
        this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
        this.maxBufferChars = options.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
    }

    /**
     * Start a call.
     *
     * @param mcpId MCP id (part of the container name).
     * @param buildArgv Builds the docker argv for the given container name.
     * @returns The new call id.
     */
    start(mcpId: string, buildArgv: (containerName: string) => string[]): string {
        this.sweepExpired();
        const callId = randomBytes(4).toString("hex");
        const containerName = `${MCP_EXEC_CONTAINER_PREFIX}${mcpId}-${callId}`;
        const child = this.spawner.spawn(buildArgv(containerName));
        const call: McpCall = {
            callId,
            mcpId,
            containerName,
            process: child,
            exited: new Promise((resolve) => {
                child.on("close", (code) => {
                    this.finish(call, code);
                    resolve();
                });
                child.on("error", (err) => {
                    this.append(call, `\nfailed to start the command: ${err.message}\n`);
                    this.finish(call, null);
                    resolve();
                });
            }),
            runtimeTimer: setTimeout(() => {
                call.isTimedOut = true;
                void this.killCall(call);
            }, this.maxRuntimeMs),
            raw: "",
            releasedTo: 0,
            isOutputTruncated: false,
            isRunning: true,
            isTimedOut: false,
            exitCode: null,
            finishedAt: null,
        };
        call.runtimeTimer.unref();
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => this.append(call, chunk));
        child.stderr?.on("data", (chunk: string) => this.append(call, chunk));
        this.calls.set(callId, call);
        return callId;
    }

    /**
     * Wait up to `waitMs` for the call to exit, then release the output
     * new since the last read, masked. A finished call is dropped after
     * this read.
     *
     * @param callId The call id from {@link start}.
     * @param waitMs Maximum wait while the call runs.
     * @param secrets Secret values to mask (collected fresh by the caller).
     * @returns The read result.
     * @throws UnknownMcpCallError for an unknown or expired call id.
     */
    async read(
        callId: string,
        waitMs: number,
        secrets: readonly string[],
    ): Promise<McpCommandReadResult> {
        const call = this.requireCall(callId);
        if (call.isRunning && waitMs > 0) {
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
                call.exited,
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, waitMs);
                }),
            ]);
            clearTimeout(timer);
        }
        return this.release(call, secrets);
    }

    /**
     * Kill a call's container and release its remaining output.
     *
     * @param callId The call id from {@link start}.
     * @param secrets Secret values to mask.
     * @returns The final read result.
     * @throws UnknownMcpCallError for an unknown or expired call id.
     */
    async stop(callId: string, secrets: readonly string[]): Promise<McpCommandReadResult> {
        const call = this.requireCall(callId);
        await this.killCall(call);
        return this.read(callId, STOP_GRACE_MS, secrets);
    }

    /** Kill every running call (daemon shutdown). */
    async stopAll(): Promise<void> {
        await Promise.all(
            [...this.calls.values()].filter((call) => call.isRunning).map((c) => this.killCall(c)),
        );
        this.calls.clear();
    }

    /**
     * Look up a call.
     *
     * @param callId The call id.
     * @returns The call.
     * @throws UnknownMcpCallError when unknown.
     */
    private requireCall(callId: string): McpCall {
        this.sweepExpired();
        const call = this.calls.get(callId);
        if (call === undefined) {
            throw new UnknownMcpCallError(callId);
        }
        return call;
    }

    /**
     * Release the masked output new since the last read.
     *
     * @param call The call.
     * @param secrets Secret values to mask.
     * @returns The read result.
     */
    private release(call: McpCall, secrets: readonly string[]): McpCommandReadResult {
        const isRunning = call.isRunning;
        const slice = maskSecretSlice(call.raw, call.releasedTo, !isRunning, secrets);
        call.releasedTo = slice.end;
        const outputTruncated = call.isOutputTruncated;
        call.isOutputTruncated = false;
        if (!isRunning) {
            this.calls.delete(call.callId);
        }
        return {
            callId: call.callId,
            running: isRunning,
            exitCode: call.exitCode,
            output: slice.text,
            outputTruncated,
            timedOut: call.isTimedOut,
        };
    }

    /**
     * Buffer output, dropping the oldest part beyond the cap.
     *
     * @param call The call.
     * @param chunk Decoded output.
     */
    private append(call: McpCall, chunk: string): void {
        call.raw += chunk;
        const excess = call.raw.length - this.maxBufferChars;
        if (excess <= 0) {
            return;
        }
        call.raw = call.raw.slice(excess);
        call.releasedTo -= excess;
        if (call.releasedTo < 0) {
            call.releasedTo = 0;
            call.isOutputTruncated = true;
        }
    }

    /**
     * Record the exit of a call's process.
     *
     * @param call The call.
     * @param code Exit code, `null` when killed by a signal.
     */
    private finish(call: McpCall, code: number | null): void {
        if (!call.isRunning) {
            return;
        }
        call.isRunning = false;
        call.exitCode = code;
        call.finishedAt = Date.now();
        clearTimeout(call.runtimeTimer);
    }

    /**
     * Remove the call's container and terminate the docker CLI process.
     *
     * @param call The call.
     */
    private async killCall(call: McpCall): Promise<void> {
        if (!call.isRunning) {
            return;
        }
        await this.spawner.kill(call.containerName);
        call.process.kill("SIGTERM");
    }

    /** Drop finished calls whose final output nobody read within the retention. */
    private sweepExpired(): void {
        const now = Date.now();
        for (const [callId, call] of this.calls) {
            if (call.finishedAt !== null && now - call.finishedAt > this.retentionMs) {
                this.calls.delete(callId);
            }
        }
    }
}
