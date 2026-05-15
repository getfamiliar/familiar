import type { IncomingMessage, ServerResponse } from "node:http";
import {
    AgentRunBus,
    EventBus,
    type Logger,
    type PostgresConnection,
} from "effective-assistant-shared";
import type { Bastion, BastionModule } from "../bastion/Bastion.js";
import type { PluginToolsRegistry, RegisteredPluginTool } from "./ToolsRegistry.js";

/** URL prefix the gateway claims on the bastion's HTTP server. */
const PREFIX = "/plugin-tools/";

/** Configuration for the {@link PluginToolsGateway} bastion module. */
export interface PluginToolsGatewayConfig {
    /**
     * Live registry of plugin-contributed tools. The gateway holds a
     * reference (not a snapshot) so registrations performed *after*
     * {@link start} resolves — which is the normal case, since plugins
     * declare tools in their `tools(ctx)` hook called by `startDaemons`
     * — are visible to subsequent requests.
     */
    readonly registry: PluginToolsRegistry;
    /**
     * Opens the host's shared postgres connection lazily. Each
     * `POST /plugin-tools/<key>` call needs it twice to load the
     * triggering event and agentrun rows. Reusing the daemon's
     * existing pool keeps the gateway free of any DB lifecycle.
     */
    readonly ensureConnection: () => Promise<PostgresConnection>;
    /** Logger child for gateway lifecycle and dispatch lines. */
    readonly log: Logger;
}

/**
 * Bastion module that serves the plugin-tools surface: catalog at
 * `GET /plugin-tools/`, invoke at `POST /plugin-tools/<key>`. Models
 * itself on {@link import("../mcp/McpGateway.js").McpGateway} —
 * registers a prefix, dispatches by id, returns clean errors.
 *
 * Wire-level invariants:
 *
 * - The catalog returns `{ key, description, inputSchema }` per tool.
 *   The container builds AI SDK `tool()` objects from this and
 *   resolves per-plugin DSL groups via the `key` prefix.
 * - Invokes are POST `application/json` with body
 *   `{ args, eventId, agentrunId }`. The gateway loads both rows,
 *   calls the registered `execute`, and answers `{ ok: true, result }`
 *   or `{ ok: false, error }` — always HTTP 200 so the agent's tool
 *   loop sees a serialized error envelope, not an HTTP failure.
 * - The bastion isn't authenticated; same trust model as `/mcp/` and
 *   `/llm/` — the agent container is the only client expected to dial
 *   `host.docker.internal:<port>`.
 */
export class PluginToolsGateway implements BastionModule {
    readonly name = "plugin-tools-gateway";

    private readonly config: PluginToolsGatewayConfig;

    constructor(config: PluginToolsGatewayConfig) {
        this.config = config;
    }

    async start(bastion: Bastion): Promise<void> {
        bastion.registerPrefix(PREFIX, (req, res, restPath) => this.dispatch(req, res, restPath));
        this.config.log.info(`plugin-tools-gateway registered ${PREFIX}`);
    }

    async stop(): Promise<void> {
        // No per-tool resources to release — execute functions live
        // inside the plugin process and follow the plugin's own
        // lifecycle. The HTTP server is owned by the bastion.
    }

    /**
     * Route a request to the catalog or invoke path. Trailing key is
     * the registry key; an empty key (request hit `/plugin-tools/`
     * exactly) means the catalog. Unknown keys 404 so the agent's
     * client sees a clear "tool gone" signal rather than a hung
     * connection.
     */
    private async dispatch(
        req: IncomingMessage,
        res: ServerResponse,
        restPath: string,
    ): Promise<void> {
        const trimmed = restPath.startsWith("/") ? restPath.slice(1) : restPath;
        const slashIdx = trimmed.indexOf("/");
        const key = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
        if (key.length === 0) {
            this.replyCatalog(req, res);
            return;
        }
        const tool = this.config.registry.get(key);
        if (tool === undefined) {
            replyError(res, 404, `unknown plugin tool "${key}"`);
            return;
        }
        if (req.method !== "POST") {
            replyError(res, 405, "POST /plugin-tools/<key> only");
            return;
        }
        await this.invoke(req, res, tool);
    }

    /**
     * Reply with `[{ key, description, inputSchema }, ...]`. Only `GET`
     * is supported; other methods get 405.
     */
    private replyCatalog(req: IncomingMessage, res: ServerResponse): void {
        if (req.method !== "GET") {
            replyError(res, 405, "GET /plugin-tools/ only");
            return;
        }
        const catalog = this.config.registry
            .list()
            .map((t) => ({ key: t.key, description: t.description, inputSchema: t.inputSchema }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(catalog));
    }

    /**
     * Read the JSON body, resolve the event + agentrun rows, and
     * invoke the plugin's `execute`. Every failure that happens
     * *during* the call — bad body, missing rows, plugin throw — is
     * serialized as `{ ok: false, error }` with HTTP 200 so the
     * agent's tool loop can render it as a tool error. Pure protocol
     * errors (wrong method, route miss) stay non-200 since they
     * indicate a client bug, not a tool-level failure.
     */
    private async invoke(
        req: IncomingMessage,
        res: ServerResponse,
        tool: RegisteredPluginTool,
    ): Promise<void> {
        let body: InvokeBody;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            this.replyError(res, asMessage(err));
            return;
        }
        if (typeof body.eventId !== "string" || body.eventId.length === 0) {
            this.replyError(res, "missing eventId");
            return;
        }
        if (typeof body.agentrunId !== "string" || body.agentrunId.length === 0) {
            this.replyError(res, "missing agentrunId");
            return;
        }

        let connection: PostgresConnection;
        try {
            connection = await this.config.ensureConnection();
        } catch (err) {
            this.replyError(res, `db connection failed: ${asMessage(err)}`);
            return;
        }

        const events = new EventBus(connection);
        const agentruns = new AgentRunBus(connection, this.config.log);
        const event = await events.getById(body.eventId);
        if (event === undefined) {
            this.replyError(res, `event ${body.eventId} not found`);
            return;
        }
        const agentrun = await agentruns.getById(body.agentrunId);
        if (agentrun === undefined) {
            this.replyError(res, `agentrun ${body.agentrunId} not found`);
            return;
        }

        const callLog = tool.log.child({
            tool: tool.key,
            eventId: event.id,
            agentrunId: agentrun.id,
        });

        try {
            const result = await tool.execute(body.args, {
                event,
                agentrun,
                host: tool.hostContext,
                log: callLog,
            });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
            const message = asMessage(err);
            callLog.error({ err: message }, "plugin tool execute threw");
            this.replyError(res, message);
        }
    }

    /** Serialized tool-level failure: HTTP 200 with `{ ok: false, error }`. */
    private replyError(res: ServerResponse, error: string): void {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error }));
    }
}

/** POST body shape — args are passed through opaquely to `execute`. */
interface InvokeBody {
    readonly args: unknown;
    readonly eventId: unknown;
    readonly agentrunId: unknown;
}

/**
 * Read the request stream to completion and parse JSON. Rejects on
 * empty bodies and non-object payloads — both are bugs in the caller,
 * not legitimate calls.
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

/** Plain-text protocol-level error: real HTTP status, no envelope. */
function replyError(res: ServerResponse, status: number, message: string): void {
    if (!res.headersSent) {
        res.writeHead(status, { "content-type": "text/plain" });
    }
    res.end(message);
}

function asMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
