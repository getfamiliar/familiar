import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import type { Logger } from "@getfamiliar/shared";
import { removeContainer } from "../../DockerTools.js";
import type { McpFileSink } from "../../tools/LogRetentionTools.js";
import type { McpTransport } from "./McpTransport.js";

/**
 * Time {@link StdioMcpTransport.killChild} waits between closing
 * stdin and force-removing the container. Chatty MCPs (the
 * Atlassian images, for example) take ~30 s to react to EOF — at
 * shutdown we'd rather not wait for them, so once this elapses we
 * `docker rm -f` the container and move on.
 */
const KILL_GRACE_MS = 5000;

/**
 * Docker container name for the spawned child. Mirrors the
 * `familiar-mcp-<id>` convention so listings (`docker ps --filter
 * name=familiar-mcp-`) still group every MCP container.
 */
function containerNameFor(id: string): string {
    return `familiar-mcp-${id}`;
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
     * familiar-mcp-<id> --network <net> [-e ...] [-v ...] [--entrypoint ...]
     * <image> [args...]`. The factory assembles this from the entry.
     */
    readonly dockerArgs: readonly string[];
    /**
     * Optional pre-spawn install argv. Run once per mount-dir
     * lifetime: the factory only sets this when the bind-mount dir
     * doesn't yet exist on disk, so a daemon restart with a populated
     * mount dir does **not** re-run prep. Used by npm/pypi sources
     * whose entry has restricted network — phase-2 `dockerArgs` can't
     * reach the registry, so phase-1 fetches with full network and no
     * env vars. To force a re-prep (e.g. after a package version bump
     * or to recover from a poisoned cache), delete the mount dir and
     * restart the daemon. When omitted, the transport single-phases
     * as before.
     */
    readonly prepDockerArgs?: readonly string[];
    /**
     * Per-MCP bind-mount directory on the host. Used by `runPrep` to
     * `rm -rf` the dir on prep failure, so the next start sees a
     * missing dir and retries — otherwise a half-populated dir would
     * make the existence-gated factory permanently skip prep while
     * phase-2 keeps failing.
     */
    readonly mountDir?: string;
    /** Seconds of idleness after which the child is closed. */
    readonly idleTimeoutSeconds: number;
    /** Logger for spawn / reap / error events. */
    readonly log: Logger;
    /**
     * Lazy opener for the per-MCP rotated log file. Called once on
     * first child spawn; the resulting sink captures every stdout
     * line tagged `out` and every stderr line tagged `err`. When
     * omitted, per-line stdio is silently dropped (today's behavior
     * before per-MCP files existed).
     */
    readonly openFileSink?: () => Promise<McpFileSink>;
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
    private readonly prepDockerArgs: readonly string[] | null;
    private readonly mountDir: string | null;
    private readonly idleTimeoutMs: number;
    private readonly log: Logger;
    private readonly openFileSink: (() => Promise<McpFileSink>) | undefined;

    private child: ChildProcessWithoutNullStreams | null = null;
    private fileSink: McpFileSink | null = null;
    private idleTimer: NodeJS.Timeout | null = null;
    private requestQueue: Promise<void> = Promise.resolve();
    private pendingResolve: ((line: string) => void) | null = null;
    private pendingReject: ((err: Error) => void) | null = null;
    private prepPromise: Promise<void> | null = null;
    /**
     * Verbatim bytes of the upstream's `initialize` request the first
     * time one flowed through this transport. Replayed silently against
     * every later cold-spawn so a respawned MCP server doesn't reject
     * the upstream's next tool call with "Received request before
     * initialization was complete". Captured raw (not re-serialised)
     * so the replayed handshake matches exactly what the upstream
     * negotiated originally (capability flags, protocol version, …).
     */
    private cachedInitializeRequest: string | null = null;
    /**
     * The `notifications/initialized` frame the upstream sent right
     * after its initialize. Replayed after the initialize on every
     * cold respawn so the child reaches `Initialized` state before
     * any tool call arrives. Some clients send it; if absent, we
     * skip the second step (the Python `mcp` library tolerates this).
     */
    private cachedInitializedNotification: string | null = null;
    /**
     * True iff the *current* child has observed an initialize +
     * notifications/initialized pair. Reset to false in the
     * `child.on("exit")` handler so the next `ensureSpawned` triggers
     * a replay against the fresh child.
     */
    private childIsInitialized = false;

    constructor(config: StdioMcpTransportConfig) {
        this.id = config.id;
        this.title = config.title;
        this.description = config.description;
        this.dockerArgs = config.dockerArgs;
        this.prepDockerArgs = config.prepDockerArgs ?? null;
        this.mountDir = config.mountDir ?? null;
        this.idleTimeoutMs = config.idleTimeoutSeconds * 1000;
        this.log = config.log;
        this.openFileSink = config.openFileSink;
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

        // Capture the upstream's initialize handshake so we can
        // transparently replay it after any future cold respawn. The
        // upstream SDK only does this once per MCPClient instance and
        // doesn't re-initialize if our docker child is reaped between
        // calls; the bastion has to fill that gap itself.
        const classification = classifyJsonRpcMessage(trimmed);
        if (classification === "initialize") {
            this.cachedInitializeRequest = trimmed;
            // Re-initialize state is invalidated until the matching
            // notifications/initialized arrives next.
            this.childIsInitialized = false;
        } else if (classification === "initialized-notification") {
            this.cachedInitializedNotification = trimmed;
            this.childIsInitialized = true;
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
        try {
            await this.killChild();
        } finally {
            await this.closeFileSink();
        }
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
        // For network-restricted MCPs the registry isn't reachable
        // from the run-phase container, so we fetch the package once
        // per transport lifetime in a separate, network-open container
        // before the real spawn.
        await this.runPrep();
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

        this.log.info(`spawning stdio mcp child '${this.id}'`);
        await this.ensureFileSink();
        const child = spawn("docker", [...this.dockerArgs], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;

        const stdoutLines = createInterface({ input: child.stdout });
        stdoutLines.on("line", (line) => {
            // Tee every stdout line into the per-MCP log file —
            // including JSON-RPC responses we hand to the waiter, so
            // a request/response trace is reconstructable from the
            // file alone.
            this.fileSink?.write("out", line);
            // Only JSON-RPC *responses* (frames carrying an `id`)
            // satisfy the in-flight request. Notifications
            // (`notifications/message`, `notifications/progress`,
            // …) and anything that doesn't parse — stray banner
            // text, log lines that escaped stderr — are dropped on
            // the floor. Without this filter, an MCP that emits
            // progress notifications during a tool call hands its
            // first notification to the waiter as if it were the
            // response, the SDK never sees the real result, and
            // the agentrun stalls until the 60 s safety timeout.
            if (classifyStdioLine(line) !== "response") {
                return;
            }
            const resolve = this.pendingResolve;
            this.pendingResolve = null;
            this.pendingReject = null;
            if (resolve !== null) {
                resolve(line);
            }
            // Server-initiated message with no waiter falls through
            // silently — the file capture is the audit trail; we no
            // longer pollute the main log with per-line debug.
        });

        const stderrLines = createInterface({ input: child.stderr });
        stderrLines.on("line", (line) => {
            // Stderr is the noisy one — model load logs, retry
            // banter, raw `console.log` output. Captured per-MCP,
            // never on the main log.
            this.fileSink?.write("err", line);
        });

        child.on("exit", (code, signal) => {
            this.log.info(`stdio mcp child '${this.id}' exited (code=${code} signal=${signal})`);
            const reject = this.pendingReject;
            this.pendingResolve = null;
            this.pendingReject = null;
            this.child = null;
            // The fresh child we spawn next will start in
            // `NotInitialized` state and reject every non-initialize
            // request until we replay. Flip the flag here, not in
            // ensureSpawned, so a crash mid-request still resets it.
            this.childIsInitialized = false;
            this.clearIdleTimer();
            if (reject !== null) {
                reject(new Error(`mcp child exited (code=${code}, signal=${signal})`));
            }
        });

        child.on("error", (err) => {
            this.log.error(`stdio mcp child '${this.id}' spawn error: ${err.message}`);
            const reject = this.pendingReject;
            this.pendingResolve = null;
            this.pendingReject = null;
            if (reject !== null) {
                reject(err);
            }
        });

        // Transparent re-initialize: if we've seen the upstream's
        // initialize before and the current child hasn't been brought
        // through it yet, replay before exchange() writes the upstream
        // payload. Order is critical — pendingResolve must be free for
        // the replay's own round-trip, which it is here because
        // exchange() sets its own waiter only AFTER ensureSpawned
        // returns.
        if (this.cachedInitializeRequest !== null && !this.childIsInitialized) {
            await this.replayInitialize();
        } else if (this.cachedInitializeRequest === null && !this.childIsInitialized) {
            // First spawn of this transport's lifetime — the upstream's
            // initialize is about to flow through normally and get
            // captured by handle(). Nothing to replay.
        }
    }

    /**
     * Send the cached `initialize` request (and the cached
     * `notifications/initialized` if any) to the freshly-spawned child
     * before any upstream payload is forwarded. Throws if the child
     * answers the initialize with a JSON-RPC error, so the upstream's
     * pending request fails fast with a clear cause instead of hanging
     * 60 s waiting for a response that will never come.
     */
    private async replayInitialize(): Promise<void> {
        const initRequest = this.cachedInitializeRequest;
        if (initRequest === null) {
            return;
        }
        const child = this.child;
        if (child === null) {
            throw new Error("replayInitialize: child not spawned");
        }
        this.log.info(`stdio mcp '${this.id}': replaying initialize after cold respawn`);
        const responsePromise = new Promise<string>((resolve, reject) => {
            this.pendingResolve = resolve;
            this.pendingReject = reject;
        });
        child.stdin.write(`${initRequest}\n`);
        const responseLine = await responsePromise;
        // Validate the response — a JSON-RPC error means the new child
        // refused the handshake (image mismatch, capability conflict,
        // …). Surface it to the caller; do not mark initialized.
        let parsed: unknown;
        try {
            parsed = JSON.parse(responseLine);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(
                `mcp '${this.id}' re-initialize failed: child returned unparseable response: ${message}`,
            );
        }
        if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
            throw new Error(
                `mcp '${this.id}' re-initialize failed: ${JSON.stringify((parsed as { error: unknown }).error)}`,
            );
        }
        const initializedFrame = this.cachedInitializedNotification;
        if (initializedFrame !== null) {
            child.stdin.write(`${initializedFrame}\n`);
        }
        this.childIsInitialized = true;
    }

    /**
     * Run the prep argv if configured, populating `/work` with the
     * MCP's package cache before phase-2 spawn. Memoised on the
     * promise so concurrent first requests share one prep run; on
     * failure the promise is cleared and the mount dir is wiped so
     * the next factory pass sees a missing dir and retries — a
     * half-populated dir would otherwise make the existence-gated
     * factory permanently skip prep while phase-2 keeps failing.
     */
    private runPrep(): Promise<void> {
        if (this.prepDockerArgs === null) {
            return Promise.resolve();
        }
        if (this.prepPromise !== null) {
            return this.prepPromise;
        }
        const args = [...this.prepDockerArgs];
        this.log.info(`prepping stdio mcp '${this.id}' (cold install)`);
        const promise = new Promise<void>((resolve, reject) => {
            const proc = spawn("docker", args, { stdio: "ignore" });
            proc.on("close", (code) => {
                if (code === 0) {
                    this.log.info(`prep complete for '${this.id}'`);
                    resolve();
                    return;
                }
                this.prepPromise = null;
                this.wipeMountDirOnPrepFailure();
                reject(new Error(`mcp '${this.id}' prep exited with code ${code}`));
            });
            proc.on("error", (err) => {
                this.prepPromise = null;
                this.wipeMountDirOnPrepFailure();
                reject(err);
            });
        });
        this.prepPromise = promise;
        return promise;
    }

    /**
     * Best-effort `rm -rf` of the per-MCP mount dir after a prep
     * failure. Wrapped so a cleanup error can't mask the original
     * prep error. No-op when no mount dir was configured (e.g.
     * one-shot bastion calls that didn't go through the factory).
     */
    private wipeMountDirOnPrepFailure(): void {
        if (this.mountDir === null) {
            return;
        }
        try {
            rmSync(this.mountDir, { recursive: true, force: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.error(`stdio mcp '${this.id}' mount dir cleanup failed: ${message}`);
        }
    }

    /** Clear and reschedule the idle reaper. */
    private resetIdleTimer(): void {
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.log.info(`stdio mcp '${this.id}' idle for ${this.idleTimeoutMs / 1000}s, reaping`);
            void this.killChild();
        }, this.idleTimeoutMs);
    }

    /**
     * Open the per-MCP rotated file sink if not yet opened. Called
     * once on first spawn; reused across the child's lifetime and
     * across cold-spawn cycles within the same transport instance.
     * A failure to open is logged and degrades silently — the child
     * still spawns; we just won't capture stdio to disk for this run.
     */
    private async ensureFileSink(): Promise<void> {
        if (this.fileSink !== null) {
            return;
        }
        if (this.openFileSink === undefined) {
            return;
        }
        try {
            this.fileSink = await this.openFileSink();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.error(`stdio mcp '${this.id}' file sink open failed: ${message}`);
        }
    }

    /** Close the per-MCP file sink if open. Idempotent. */
    private async closeFileSink(): Promise<void> {
        const sink = this.fileSink;
        if (sink === null) {
            return;
        }
        this.fileSink = null;
        try {
            await sink.close();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.error(`stdio mcp '${this.id}' file sink close failed: ${message}`);
        }
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
            let done = false;
            const finish = (): void => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(grace);
                resolve();
            };
            // SIGKILL on the local `docker run` CLI process does
            // NOT cascade to the container — dockerd owns the
            // container's lifecycle. Force-remove the container
            // instead so PID 1 inside it dies; the local CLI then
            // exits as a side effect within ms.
            const grace = setTimeout(() => {
                void removeContainer(containerNameFor(this.id))
                    .catch(() => undefined)
                    .finally(finish);
            }, KILL_GRACE_MS);
            child.once("exit", finish);
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
 * Classify an inbound JSON-RPC body so {@link StdioMcpTransport} can
 * capture the upstream's `initialize` handshake for transparent replay
 * after a cold respawn. Returns:
 *
 * - `"initialize"` — request frame with `method === "initialize"`.
 *   The bytes are stashed verbatim and replayed against every later
 *   fresh child.
 * - `"initialized-notification"` — notification with
 *   `method === "notifications/initialized"`. Marks the child as
 *   initialized and is replayed after every cached initialize replay.
 * - `"other"` — any other valid JSON-RPC frame; no capture action.
 * - `"unparseable"` — JSON.parse fails. Treated as `"other"` by the
 *   caller; the dedicated variant exists for diagnostic logging.
 *
 * Exported for unit testing.
 */
export function classifyJsonRpcMessage(
    payload: string,
): "initialize" | "initialized-notification" | "other" | "unparseable" {
    let parsed: unknown;
    try {
        parsed = JSON.parse(payload);
    } catch {
        return "unparseable";
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "other";
    }
    const method = (parsed as { method?: unknown }).method;
    if (method === "initialize") {
        return "initialize";
    }
    if (method === "notifications/initialized") {
        return "initialized-notification";
    }
    return "other";
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

/**
 * Classify one line of MCP stdio output. Only `"response"` —
 * a JSON object carrying an `id` — should satisfy a waiter parked
 * by {@link StdioMcpTransport.exchange}. Everything else
 * (server-initiated `notifications/*` frames, stray banner lines,
 * unparseable text) is `"non-response"` and gets dropped on the
 * floor by the stdout reader; the per-MCP log file captures
 * those for audit.
 *
 * Note this differs from {@link isJsonRpcNotification}: that
 * function's contract is "should this *inbound POST body* be
 * forwarded as a notification or treated as a request", which
 * means unparseable input falls through to the request path
 * (let the child error explicitly). Here, unparseable stdout is
 * never a valid response, so we drop it.
 */
export function classifyStdioLine(line: string): "response" | "non-response" {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return "non-response";
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "non-response";
    }
    return Object.hasOwn(parsed, "id") ? "response" : "non-response";
}
