import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AgentRunBus, EventBus, type Logger, type PostgresConnection } from "@getfamiliar/shared";
import type { EventContextRegistry } from "../plugins/EventContextRegistry.js";
import type { Bastion, BastionModule } from "./Bastion.js";

/** URL prefix the gateway claims on the bastion's HTTP server. */
const PREFIX = "/event-context/";

/**
 * Per-provider timeout. A single slow provider must not delay every
 * agentrun's prompt assembly; the gateway races each provider against
 * this cap and records a timeout in place of its output. Set
 * deliberately tight — providers are expected to be cheap lookups, not
 * round-trips to slow third-party APIs.
 */
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;

/** Configuration for the {@link EventContextGateway} bastion module. */
export interface EventContextGatewayConfig {
    /**
     * Live registry of plugin-contributed providers. The gateway holds a
     * reference (not a snapshot) so registrations performed *after*
     * {@link start} resolves — which is the normal case, since plugins
     * register in their `start(ctx)` hook called by `startDaemons` —
     * are visible to subsequent requests.
     */
    readonly registry: EventContextRegistry;
    /**
     * Opens the host's shared postgres connection lazily. Each
     * `POST /event-context/` call needs it twice: once to load the
     * triggering event, once for the agentrun row.
     */
    readonly ensureConnection: () => Promise<PostgresConnection>;
    /** Logger child for gateway lifecycle and dispatch lines. */
    readonly log: Logger;
    /**
     * Optional override for the per-provider timeout. Defaults to
     * {@link DEFAULT_PROVIDER_TIMEOUT_MS}.
     */
    readonly providerTimeoutMs?: number;
}

/**
 * One section returned to the container per non-empty provider output.
 * The container decides rendering; the gateway just transports.
 */
export interface EventContextSection {
    readonly pluginId: string;
    readonly text: string;
}

/** Response body shape served by `POST /event-context/`. */
export interface EventContextResponse {
    readonly sections: readonly EventContextSection[];
}

/**
 * Bastion module that fans plugin-registered event-context providers
 * out in parallel for the container's PromptBuilder. Mirrors
 * {@link import("../plugins/ToolsGateway.js").PluginToolsGateway} in
 * shape: claims a single prefix, accepts JSON POSTs, returns clean
 * payloads on the wire.
 *
 * Wire-level invariants:
 *
 * - POST `/event-context/` with body `{ eventId, agentrunId }` runs
 *   every registered provider in parallel via `Promise.allSettled`,
 *   each capped by `providerTimeoutMs`.
 * - Rejections and timeouts are logged with the offending plugin id
 *   and skipped — one bad provider must not poison the prompt.
 * - Providers that return `null`, `undefined`, or a whitespace-only
 *   string contribute no section to the response. Useful for "only
 *   speak up when relevant" providers.
 * - 200 with `{ sections: [] }` is a valid response (nothing
 *   registered, or every provider was empty / errored).
 * - 4xx for malformed requests, 5xx for transport faults (DB
 *   unavailable). Provider-side errors never surface as a non-200.
 * - The bastion isn't authenticated; same trust model as `/mcp/` and
 *   `/plugin-tools/`.
 */
export class EventContextGateway implements BastionModule {
    readonly name = "event-context-gateway";

    private readonly config: EventContextGatewayConfig;
    private readonly providerTimeoutMs: number;

    constructor(config: EventContextGatewayConfig) {
        this.config = config;
        this.providerTimeoutMs = config.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    }

    async start(bastion: Bastion): Promise<void> {
        bastion.registerPrefix(PREFIX, (req, res) => this.dispatch(req, res));
        this.config.log.info(`event-context-gateway registered ${PREFIX}`);
    }

    async stop(): Promise<void> {
        // Provider functions live inside plugin processes and follow
        // the plugin's own lifecycle. The HTTP server is owned by the
        // bastion.
    }

    /**
     * Single-route dispatch. Only `POST /event-context/` is accepted;
     * anything else gets a `405`. The route does not nest below the
     * prefix — there is no per-provider key on the wire because the
     * fan-out happens server-side.
     */
    private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method !== "POST") {
            replyHttpError(res, 405, "POST /event-context/ only");
            return;
        }
        let body: InvokeBody;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            replyHttpError(res, 400, asMessage(err));
            return;
        }
        if (typeof body.eventId !== "string" || body.eventId.length === 0) {
            replyHttpError(res, 400, "missing eventId");
            return;
        }
        if (typeof body.agentrunId !== "string" || body.agentrunId.length === 0) {
            replyHttpError(res, 400, "missing agentrunId");
            return;
        }

        let connection: PostgresConnection;
        try {
            connection = await this.config.ensureConnection();
        } catch (err) {
            replyHttpError(res, 503, `db connection failed: ${asMessage(err)}`);
            return;
        }

        const events = new EventBus(connection);
        const agentruns = new AgentRunBus(connection, this.config.log);
        const event = await events.getById(body.eventId);
        if (event === undefined) {
            replyHttpError(res, 404, `event ${body.eventId} not found`);
            return;
        }
        const agentrun = await agentruns.getById(body.agentrunId);
        if (agentrun === undefined) {
            replyHttpError(res, 404, `agentrun ${body.agentrunId} not found`);
            return;
        }

        const entries = this.config.registry.list();
        const sections: EventContextSection[] = [];
        if (entries.length > 0) {
            const settled = await Promise.allSettled(
                entries.map((entry) =>
                    runWithTimeout(() => entry.fn(agentrun, event), this.providerTimeoutMs).then(
                        (text) => ({ pluginId: entry.pluginId, text }),
                    ),
                ),
            );
            for (let i = 0; i < settled.length; i++) {
                const result = settled[i];
                const pluginId = entries[i].pluginId;
                if (result.status === "rejected") {
                    this.config.log.warn(
                        {
                            pluginId,
                            eventId: event.id,
                            agentrunId: agentrun.id,
                            err: asMessage(result.reason),
                        },
                        "event-context provider failed",
                    );
                    continue;
                }
                const text = result.value.text;
                if (typeof text !== "string" || text.trim().length === 0) {
                    continue;
                }
                sections.push({ pluginId, text });
            }
        }

        const responseBody: EventContextResponse = { sections };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseBody));
    }
}

/** POST body shape. */
interface InvokeBody {
    readonly eventId: unknown;
    readonly agentrunId: unknown;
}

/**
 * Read the request stream to completion and parse JSON. Rejects on
 * empty bodies and non-object payloads.
 */
async function readJsonBody(req: IncomingMessage): Promise<InvokeBody> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) {
        throw new Error("empty request body");
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`invalid JSON body: ${asMessage(err)}`);
    }
    if (parsed === null || typeof parsed !== "object") {
        throw new Error("request body must be a JSON object");
    }
    return parsed as InvokeBody;
}

/**
 * Race `task()` against a `setTimeout`. The timer is cleared on the
 * happy path so the event loop isn't held alive by leaked timers when
 * the gateway is idle.
 */
function runWithTimeout<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`provider timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        task().then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

function replyHttpError(res: ServerResponse, status: number, message: string): void {
    if (!res.headersSent) {
        res.writeHead(status, { "content-type": "text/plain" });
    }
    res.end(message);
}

function asMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
