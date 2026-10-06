import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    AgentRunBus,
    type AgentRunRow,
    EventBus,
    type EventRow,
    type Logger,
    type PostgresConnection,
} from "@getfamiliar/shared";
import type { PromptAppenderRegistry } from "../plugins/PromptAppenderRegistry.js";
import type { PromptPlaceholderRegistry } from "../plugins/PromptPlaceholderRegistry.js";
import type { Bastion, BastionModule } from "./Bastion.js";

/** Route serving plugin prompt appenders. */
const APPENDERS_PREFIX = "/prompt-appenders/";

/** Route serving plugin-registered placeholder values. */
const PLACEHOLDERS_PREFIX = "/prompt-placeholders/";

/**
 * Per-call timeout for one appender or placeholder function. A single
 * slow plugin must not delay every agentrun's prompt assembly; the
 * gateway races each call against this cap. Set deliberately tight —
 * these are expected to be cheap lookups, not round-trips to slow
 * third-party APIs.
 */
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;

/** Configuration for the {@link PromptGateway} bastion module. */
export interface PromptGatewayConfig {
    /**
     * Live registry of plugin appenders. Held by reference so
     * registrations made after {@link PromptGateway.start} (plugins
     * register appenders in `start(ctx)`) are visible to later requests.
     */
    readonly appenders: PromptAppenderRegistry;
    /** Live registry of plugin placeholders. */
    readonly placeholders: PromptPlaceholderRegistry;
    /**
     * Opens the host's shared postgres connection lazily. Each real
     * (non-dry-run) request loads the triggering event and the agentrun.
     */
    readonly ensureConnection: () => Promise<PostgresConnection>;
    /** Logger child for gateway lifecycle and dispatch lines. */
    readonly log: Logger;
    /** Optional override for the per-call timeout. */
    readonly providerTimeoutMs?: number;
}

/** One appended section returned to the container per non-empty appender output. */
export interface PromptAppenderSection {
    readonly pluginId: string;
    readonly text: string;
}

/** Response body of `POST /prompt-appenders/`. */
export interface PromptAppendersResponse {
    readonly sections: readonly PromptAppenderSection[];
}

/** Response body of `POST /prompt-placeholders/`. */
export interface PromptPlaceholdersResponse {
    /** Value per requested, plugin-registered name (empty string for null results). */
    readonly values: Readonly<Record<string, string>>;
    /** Requested names no plugin registered. */
    readonly unknown: readonly string[];
    /** Error message per requested name whose provider failed or timed out. */
    readonly errors: Readonly<Record<string, string>>;
}

/**
 * Synthetic run description for `familiar prompt dry-run`: the gateway
 * fabricates agentrun / event rows from it instead of loading real ones.
 */
interface DryRunInput {
    readonly topic: string;
    readonly handler: string;
    readonly prompt: string | null;
    readonly privileged: boolean;
}

/**
 * Bastion module serving the plugin side of prompt assembly to the
 * container's PromptBuilder:
 *
 * - `POST /prompt-appenders/` with `{ eventId, agentrunId }` runs every
 *   registered appender in parallel and returns the non-empty sections.
 * - `POST /prompt-placeholders/` with `{ eventId, agentrunId, names }`
 *   resolves only the requested plugin placeholders.
 *
 * Either route accepts `{ dryRun: { topic, handler, prompt, privileged } }`
 * in place of the ids; it then hands synthetic rows to the plugins so
 * `familiar prompt dry-run` sees real plugin output without a run.
 *
 * Plugin-side failures and timeouts are logged with the plugin id and
 * skipped — one bad plugin must not poison the prompt. 4xx for malformed
 * requests, 5xx for transport faults (DB unavailable). Authentication is
 * the bastion's shared-token check (in `HttpServer`).
 */
export class PromptGateway implements BastionModule {
    readonly name = "prompt-gateway";

    private readonly config: PromptGatewayConfig;
    private readonly providerTimeoutMs: number;

    /** @param config Registries, DB access and logger. */
    constructor(config: PromptGatewayConfig) {
        this.config = config;
        this.providerTimeoutMs = config.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    }

    /**
     * Claim both routes on the bastion.
     *
     * @param bastion The running bastion.
     */
    async start(bastion: Bastion): Promise<void> {
        bastion.registerPrefix(APPENDERS_PREFIX, (req, res) =>
            this.dispatch(req, res, APPENDERS_PREFIX, (rows) => this.runAppenders(rows)),
        );
        bastion.registerPrefix(PLACEHOLDERS_PREFIX, (req, res) =>
            this.dispatch(req, res, PLACEHOLDERS_PREFIX, (rows, body) =>
                this.resolvePlaceholders(rows, body),
            ),
        );
        this.config.log.info(
            `prompt-gateway registered ${APPENDERS_PREFIX} and ${PLACEHOLDERS_PREFIX}`,
        );
    }

    /** Nothing to release; the HTTP server is owned by the bastion. */
    async stop(): Promise<void> {}

    /**
     * Shared request handling: method check, body parsing, row loading,
     * then hand off to the route-specific `respond`.
     */
    private async dispatch(
        req: IncomingMessage,
        res: ServerResponse,
        route: string,
        respond: (rows: RunRows, body: RequestBody) => Promise<unknown>,
    ): Promise<void> {
        if (req.method !== "POST") {
            replyHttpError(res, 405, `POST ${route} only`);
            return;
        }
        let body: RequestBody;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            replyHttpError(res, 400, asMessage(err));
            return;
        }
        let rows: RunRows | HttpFailure;
        try {
            rows = await this.loadRows(body);
        } catch (err) {
            replyHttpError(res, 503, `db connection failed: ${asMessage(err)}`);
            return;
        }
        if ("status" in rows) {
            replyHttpError(res, rows.status, rows.message);
            return;
        }
        const responseBody = await respond(rows, body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseBody));
    }

    /**
     * Load the real agentrun and event, or fabricate them for a dry run.
     *
     * @throws When the DB connection cannot be opened.
     */
    private async loadRows(body: RequestBody): Promise<RunRows | HttpFailure> {
        if (body.dryRun !== undefined) {
            const dryRun = parseDryRun(body.dryRun);
            if (dryRun === null) {
                return { status: 400, message: "malformed dryRun" };
            }
            return buildDryRunRows(dryRun);
        }
        if (typeof body.eventId !== "string" || body.eventId.length === 0) {
            return { status: 400, message: "missing eventId" };
        }
        if (typeof body.agentrunId !== "string" || body.agentrunId.length === 0) {
            return { status: 400, message: "missing agentrunId" };
        }
        const connection = await this.config.ensureConnection();
        const event = await new EventBus(connection).getById(body.eventId);
        if (event === undefined) {
            return { status: 404, message: `event ${body.eventId} not found` };
        }
        const agentrun = await new AgentRunBus(connection, this.config.log).getById(
            body.agentrunId,
        );
        if (agentrun === undefined) {
            return { status: 404, message: `agentrun ${body.agentrunId} not found` };
        }
        return { agentrun, event };
    }

    /** Fan out to every appender in parallel; keep the non-empty results. */
    private async runAppenders(rows: RunRows): Promise<PromptAppendersResponse> {
        const entries = this.config.appenders.list();
        const settled = await Promise.allSettled(
            entries.map((entry) =>
                runWithTimeout(() => entry.fn(rows.agentrun, rows.event), this.providerTimeoutMs),
            ),
        );
        const sections: PromptAppenderSection[] = [];
        for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            const pluginId = entries[i].pluginId;
            if (result.status === "rejected") {
                this.config.log.warn(
                    { pluginId, eventId: rows.event.id, agentrunId: rows.agentrun.id },
                    `prompt appender of plugin ${pluginId} failed for agentrun ${rows.agentrun.id}: ${asMessage(result.reason)}`,
                );
                continue;
            }
            const text = result.value;
            if (typeof text !== "string" || text.trim().length === 0) {
                continue;
            }
            sections.push({ pluginId, text });
        }
        return { sections };
    }

    /** Resolve the requested plugin placeholders in parallel. */
    private async resolvePlaceholders(
        rows: RunRows,
        body: RequestBody,
    ): Promise<PromptPlaceholdersResponse> {
        const names = Array.isArray(body.names)
            ? body.names.filter((n): n is string => typeof n === "string")
            : [];
        const unknown: string[] = [];
        const known = names.flatMap((name) => {
            const registration = this.config.placeholders.get(name);
            if (registration === undefined) {
                unknown.push(name);
                return [];
            }
            return [registration];
        });
        const settled = await Promise.allSettled(
            known.map((registration) =>
                runWithTimeout(
                    () => registration.provide(rows.agentrun, rows.event),
                    this.providerTimeoutMs,
                ),
            ),
        );
        const values: Record<string, string> = {};
        const errors: Record<string, string> = {};
        for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            const { name, pluginId } = known[i];
            if (result.status === "rejected") {
                const message = asMessage(result.reason);
                errors[name] = message;
                this.config.log.warn(
                    { pluginId, placeholder: name, agentrunId: rows.agentrun.id },
                    `prompt placeholder {${name}} of plugin ${pluginId} failed for agentrun ${rows.agentrun.id}: ${message}`,
                );
                continue;
            }
            values[name] = typeof result.value === "string" ? result.value : "";
        }
        return { values, unknown, errors };
    }
}

/** The pair of rows every appender / placeholder function receives. */
interface RunRows {
    readonly agentrun: AgentRunRow;
    readonly event: EventRow;
}

/** A request that must be answered with an HTTP error. */
interface HttpFailure {
    readonly status: number;
    readonly message: string;
}

/** POST body shape shared by both routes. */
interface RequestBody {
    readonly eventId?: unknown;
    readonly agentrunId?: unknown;
    readonly names?: unknown;
    readonly dryRun?: unknown;
}

/**
 * Validate the `dryRun` body field.
 *
 * @returns The parsed input, or `null` when malformed.
 */
function parseDryRun(raw: unknown): DryRunInput | null {
    if (raw === null || typeof raw !== "object") {
        return null;
    }
    const value = raw as Record<string, unknown>;
    if (typeof value.topic !== "string" || typeof value.handler !== "string") {
        return null;
    }
    return {
        topic: value.topic,
        handler: value.handler,
        prompt: typeof value.prompt === "string" ? value.prompt : null,
        privileged: value.privileged === true,
    };
}

/**
 * Fabricate the agentrun / event rows a dry run hands to plugins.
 *
 * @param input The dry-run description.
 * @returns Rows shaped like a fresh root agentrun for a new event.
 */
function buildDryRunRows(input: DryRunInput): RunRows {
    const now = new Date();
    const event: EventRow = {
        id: "dry-run-event",
        topic: input.topic,
        priority: 0,
        state: "running",
        payload: null,
        idempotencyKey: null,
        isChat: false,
        preferredChatChannelId: null,
        prompt: input.prompt ?? "",
        startHandler: input.handler,
        privileged: input.privileged,
        outputChatOnFailure: false,
        createdAt: now,
        updatedAt: now,
    };
    const agentrun: AgentRunRow = {
        id: "dry-run-agentrun",
        eventId: event.id,
        parentAgentrunId: null,
        topic: input.topic,
        handler: input.handler,
        model: null,
        priority: 0,
        state: "running",
        prompt: input.prompt,
        systemPrompt: null,
        initialMessages: null,
        payload: null,
        result: null,
        resultText: null,
        error: null,
        privileged: input.privileged,
        calltype: null,
        retryCount: 0,
        notBefore: null,
        createdAt: now,
        updatedAt: now,
    };
    return { agentrun, event };
}

/**
 * Read the request stream to completion and parse JSON. Rejects on
 * empty bodies and non-object payloads.
 */
async function readJsonBody(req: IncomingMessage): Promise<RequestBody> {
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
    return parsed as RequestBody;
}

/**
 * Race `task()` against a `setTimeout`. The timer is cleared on the
 * happy path so the event loop isn't held alive by leaked timers when
 * the gateway is idle.
 */
function runWithTimeout<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`timed out after ${timeoutMs}ms`));
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
