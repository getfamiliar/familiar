import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import type { Logger } from "effective-assistant-shared";
import type { McpTransport } from "./McpTransport.js";

/**
 * Docker container name for the spawned child. Mirrors the
 * `ea-mcp-<id>` convention so listings (`docker ps --filter
 * name=ea-mcp-`) still group every MCP container.
 */
function containerNameFor(id: string): string {
    return `ea-mcp-${id}`;
}

/**
 * Configuration for an `StdioMcpTransport`. Built by the source
 * factory from a validated `McpEntry`.
 */
export interface StdioMcpTransportConfig {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    /**
     * Argv vector to pass to `docker` (without the leading "docker").
     * Must be a foreground-style invocation: `run -i --rm --name
     * ea-mcp-<id> --network <net> [-e ...] [-v ...] [--entrypoint ...]
     * <image> [args...]`. The factory assembles this from the entry.
     */
    readonly dockerArgs: readonly string[];
    /** Seconds of idleness after which the child is closed. */
    readonly idleTimeoutSeconds: number;
    /** Logger for spawn / reap / error events. */
    readonly log: Logger;
}

/**
 * Stdio-transport MCP. Spawns a `docker run -i` child on first
 * request, holds its stdio pipes, multiplexes JSON-RPC requests over
 * stdin/stdout (newline-delimited per the MCP spec), and reaps the
 * child after `idleTimeoutSeconds` of inactivity.
 *
 * Design choices for v1:
 *
 * - **Plain HTTP request → plain JSON response.** No SSE / Streamable
 *   HTTP yet. Each call POSTs one JSON-RPC payload, gets one response.
 *   Server-initiated notifications and progress streaming are deferred.
 * - **Per-child serialized requests.** A simple FIFO queue ensures one
 *   in-flight request per child; the next one waits for the previous
 *   response line. Most MCP servers handle requests sequentially over
 *   stdio anyway, and serializing avoids id-correlation complexity.
 * - **Cold-start on demand.** No pre-spawn; the first request pays a
 *   docker-run cost (~1–2 s once the image is pulled).
 * - **`--rm` reaps automatically.** When stdin closes the child exits;
 *   `--rm` then deletes the container. We don't manually call
 *   `docker rm` from the bastion.
 */
export class StdioMcpTransport implements McpTransport {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    private readonly dockerArgs: readonly string[];
    private readonly idleTimeoutMs: number;
    private readonly log: Logger;

    private child: ChildProcessWithoutNullStreams | null = null;
    private idleTimer: NodeJS.Timeout | null = null;
    private requestQueue: Promise<void> = Promise.resolve();
    private pendingResolve: ((line: string) => void) | null = null;
    private pendingReject: ((err: Error) => void) | null = null;

    constructor(config: StdioMcpTransportConfig) {
        this.id = config.id;
        this.title = config.title;
        this.description = config.description;
        this.dockerArgs = config.dockerArgs;
        this.idleTimeoutMs = config.idleTimeoutSeconds * 1000;
        this.log = config.log;
    }

    async handle(req: IncomingMessage, res: ServerResponse, _restPath: string): Promise<void> {
        if (req.method !== "POST") {
            replyError(res, 405, "stdio MCP transport only accepts POST");
            return;
        }
        let body: string;
        try {
            body = await readRequestBody(req);
        } catch (err) {
            replyError(res, 400, `read body: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        const trimmed = body.trim();
        if (trimmed.length === 0) {
            replyError(res, 400, "empty body");
            return;
        }

        // Notifications (JSON-RPC frames without an `id`) elicit no
        // server response per the spec. Forward them to the child for
        // ordering, but reply 202 immediately — never park a pending
        // resolver, which would hang waiting for stdout that won't
        // come.
        if (isJsonRpcNotification(trimmed)) {
            const notifyTurn = this.requestQueue.then(() => this.notify(trimmed));
            this.requestQueue = notifyTurn.then(
                () => undefined,
                () => undefined,
            );
            try {
                await notifyTurn;
                res.writeHead(202).end();
            } catch (err) {
                replyError(
                    res,
                    502,
                    `mcp child error: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
            return;
        }

        const turn = this.requestQueue.then(() => this.exchange(trimmed));
        // Keep the queue moving even if this turn rejects.
        this.requestQueue = turn.then(
            () => undefined,
            () => undefined,
        );

        try {
            const responseLine = await turn;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(responseLine);
        } catch (err) {
            replyError(
                res,
                502,
                `mcp child error: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    /**
     * Forward a JSON-RPC notification to the child. Spawns the child
     * if needed, writes the line, resets the idle timer, and resolves
     * without waiting for any response — by spec there isn't one.
     */
    private async notify(payload: string): Promise<void> {
        await this.ensureSpawned();
        const child = this.child;
        if (child === null) {
            throw new Error("child process not running after spawn");
        }
        child.stdin.write(`${payload}\n`);
        this.resetIdleTimer();
    }

    async stop(): Promise<void> {
        this.clearIdleTimer();
        await this.killChild();
    }

    /**
     * Send one JSON-RPC frame to the child and resolve with the next
     * line of stdout. Spawns the child if it isn't running. Resets the
     * idle timer on success.
     */
    private async exchange(payload: string): Promise<string> {
        await this.ensureSpawned();
        const child = this.child;
        if (child === null) {
            throw new Error("child process not running after spawn");
        }
        const responsePromise = new Promise<string>((resolve, reject) => {
            this.pendingResolve = resolve;
            this.pendingReject = reject;
        });
        child.stdin.write(`${payload}\n`);
        this.resetIdleTimer();
        return responsePromise;
    }

    /**
     * Spawn the docker child if not already running, and wire up
     * stdout line reader, stderr passthrough, exit handler. Idempotent.
     */
    private async ensureSpawned(): Promise<void> {
        if (this.child !== null) {
            return;
        }
        // Idempotent cleanup: a previous crash may have left a stale
        // container with the same name. `--rm` should have removed it,
        // but defensively we try first.
        await new Promise<void>((resolve) => {
            const proc = spawn("docker", ["rm", "-f", containerNameFor(this.id)], {
                stdio: "ignore",
            });
            proc.on("close", () => {
                resolve();
            });
            proc.on("error", () => {
                resolve();
            });
        });

        this.log.info({ mcp: this.id }, "spawning stdio mcp child");
        const child = spawn("docker", [...this.dockerArgs], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;

        const stdoutLines = createInterface({ input: child.stdout });
        stdoutLines.on("line", (line) => {
            const resolve = this.pendingResolve;
            this.pendingResolve = null;
            this.pendingReject = null;
            if (resolve !== null) {
                resolve(line);
            } else {
                // Server-initiated message with no waiter — log and drop.
                this.log.debug({ mcp: this.id, line }, "unsolicited mcp output");
            }
        });

        const stderrLines = createInterface({ input: child.stderr });
        stderrLines.on("line", (line) => {
            this.log.debug({ mcp: this.id, line }, "mcp stderr");
        });

        child.on("exit", (code, signal) => {
            this.log.info({ mcp: this.id, code, signal }, "stdio mcp child exited");
            const reject = this.pendingReject;
            this.pendingResolve = null;
            this.pendingReject = null;
            this.child = null;
            this.clearIdleTimer();
            if (reject !== null) {
                reject(new Error(`mcp child exited (code=${code}, signal=${signal})`));
            }
        });

        child.on("error", (err) => {
            this.log.error({ mcp: this.id, err: err.message }, "stdio mcp child spawn error");
            const reject = this.pendingReject;
            this.pendingResolve = null;
            this.pendingReject = null;
            if (reject !== null) {
                reject(err);
            }
        });
    }

    /** Clear and reschedule the idle reaper. */
    private resetIdleTimer(): void {
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.log.info(
                { mcp: this.id, idleSeconds: this.idleTimeoutMs / 1000 },
                "stdio mcp idle, reaping",
            );
            void this.killChild();
        }, this.idleTimeoutMs);
    }

    /** Cancel the idle reaper if scheduled. */
    private clearIdleTimer(): void {
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    /**
     * Close the child by ending stdin. The MCP server detects EOF and
     * exits; `--rm` removes the container. If the child doesn't exit
     * within 5 s we SIGKILL it so shutdown isn't blocked.
     */
    private async killChild(): Promise<void> {
        const child = this.child;
        if (child === null) {
            return;
        }
        try {
            child.stdin.end();
        } catch {
            // ignore — pipe might already be closed
        }
        await new Promise<void>((resolve) => {
            const grace = setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                } catch {
                    // ignore
                }
                resolve();
            }, 5_000);
            child.once("exit", () => {
                clearTimeout(grace);
                resolve();
            });
        });
        this.child = null;
    }
}

/** Collect a request body into a single string. */
function readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
        });
        req.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf-8"));
        });
        req.on("error", reject);
    });
}

/** Send a plain-text error response with the given status. */
function replyError(res: ServerResponse, status: number, message: string): void {
    if (!res.headersSent) {
        res.writeHead(status, { "content-type": "text/plain" });
    }
    res.end(message);
}

/**
 * Tell whether a body is a JSON-RPC 2.0 notification: a single
 * object lacking the `id` field. Anything that isn't valid JSON, or
 * is an array (batch) or an object with `id`, falls through to the
 * request path. Batches with notifications mixed in aren't supported
 * yet — we'd need a richer correlator before that's worth doing.
 */
function isJsonRpcNotification(payload: string): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(payload);
    } catch {
        return false;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return false;
    }
    return !Object.hasOwn(parsed, "id");
}
