import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    AgentRunBus,
    DEFAULT_TOOL_CALL_OFFLOADING_LIMIT,
    EventBus,
    type Logger,
    type PostgresConnection,
    ToolError,
    type ToolRunContext,
} from "@getfamiliar/shared";
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
 *   `{ args, eventId, agentrunId, toolCallOffloadingLimit }`. The
 *   gateway loads both rows, constructs a {@link ToolRunContext} that
 *   spills oversized results into the event's scratch dir, calls the
 *   registered `execute`, and answers with the runner's return value
 *   verbatim (success body = bare result) or `{ ok: false, code,
 *   message, status? }` on a thrown `ToolError`. HTTP 200 throughout;
 *   reserve 5xx for transport faults.
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
            replyHttpError(res, 404, `unknown plugin tool "${key}"`);
            return;
        }
        if (req.method !== "POST") {
            replyHttpError(res, 405, "POST /plugin-tools/<key> only");
            return;
        }
        await this.invoke(req, res, tool);
    }

    /**
     * Reply with `[{ key, pluginId, description, inputSchema, system },
     * ...]`. Only `GET` is supported; other methods get 405. `system`
     * tells the container which plugin tools should join its built-in
     * `system` DSL group (and thus the implicit default tool set).
     */
    private replyCatalog(req: IncomingMessage, res: ServerResponse): void {
        if (req.method !== "GET") {
            replyHttpError(res, 405, "GET /plugin-tools/ only");
            return;
        }
        const catalog = this.config.registry.list().map((t) => ({
            key: t.key,
            pluginId: t.pluginId,
            description: t.description,
            inputSchema: t.inputSchema,
            system: t.system,
        }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(catalog));
    }

    /**
     * Read the JSON body, resolve the event + agentrun rows, build the
     * per-call {@link ToolRunContext}, and invoke the plugin's
     * `execute`. Returns the runner's value verbatim on success; on
     * thrown `ToolError`, serializes `{ok:false, code, message, status?}`
     * with HTTP 200 so the container's `ToolsClient` re-throws and the
     * AI SDK emits a `tool-error` block. Other throws become an HTTP
     * 200 `Transport`-coded body for the same reason.
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
            replyFailureBody(res, "BadRequest", asMessage(err));
            return;
        }
        if (typeof body.eventId !== "string" || body.eventId.length === 0) {
            replyFailureBody(res, "BadRequest", "missing eventId");
            return;
        }
        if (typeof body.agentrunId !== "string" || body.agentrunId.length === 0) {
            replyFailureBody(res, "BadRequest", "missing agentrunId");
            return;
        }
        const limit =
            typeof body.toolCallOffloadingLimit === "number" &&
            Number.isFinite(body.toolCallOffloadingLimit) &&
            body.toolCallOffloadingLimit > 0
                ? body.toolCallOffloadingLimit
                : DEFAULT_TOOL_CALL_OFFLOADING_LIMIT;

        let connection: PostgresConnection;
        try {
            connection = await this.config.ensureConnection();
        } catch (err) {
            replyFailureBody(res, "Transport", `db connection failed: ${asMessage(err)}`);
            return;
        }

        const events = new EventBus(connection);
        const agentruns = new AgentRunBus(connection, this.config.log);
        const event = await events.getById(body.eventId);
        if (event === undefined) {
            replyFailureBody(res, "BadRequest", `event ${body.eventId} not found`);
            return;
        }
        const agentrun = await agentruns.getById(body.agentrunId);
        if (agentrun === undefined) {
            replyFailureBody(res, "BadRequest", `agentrun ${body.agentrunId} not found`);
            return;
        }

        const callLog = tool.log.child({
            tool: tool.key,
            eventId: event.id,
            agentrunId: agentrun.id,
        });

        const toolRunContext = buildHostToolRunContext(tool.hostContext, event.id, limit);

        try {
            const result = await tool.execute(body.args, {
                event,
                agentrun,
                host: tool.hostContext,
                log: callLog,
                toolRunContext,
            });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(result ?? {}));
        } catch (err) {
            if (err instanceof ToolError) {
                callLog.warn(
                    { code: err.code, status: err.status, message: err.message },
                    "plugin tool ToolError",
                );
                replyFailureBody(res, err.code, err.message, err.status);
                return;
            }
            const message = asMessage(err);
            callLog.error({ err: message }, "plugin tool execute threw");
            replyFailureBody(res, "ToolError", message);
        }
    }
}

/** Wire-level success body is the runner output verbatim — no envelope. */

/**
 * Wire-level failure body: `{ok:false, code, message, status?}`.
 * Returned with HTTP 200 so the agent's tool loop sees a serialised
 * envelope instead of a transport-level failure.
 */
function replyFailureBody(
    res: ServerResponse,
    code: string,
    message: string,
    status?: number,
): void {
    res.writeHead(200, { "content-type": "application/json" });
    const body =
        status === undefined ? { ok: false, code, message } : { ok: false, code, message, status };
    res.end(JSON.stringify(body));
}

/** POST body shape — args are passed through opaquely to `execute`. */
interface InvokeBody {
    readonly args: unknown;
    readonly eventId: unknown;
    readonly agentrunId: unknown;
    readonly toolCallOffloadingLimit?: unknown;
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
function replyHttpError(res: ServerResponse, status: number, message: string): void {
    if (!res.headersSent) {
        res.writeHead(status, { "content-type": "text/plain" });
    }
    res.end(message);
}

/**
 * Build the per-call {@link ToolRunContext} used by host-side tools.
 * `spill` writes oversized results into `/scratch/<eventId>/` via the
 * plugin's own scratch surface (`host.scratch.addFiles`) — the same
 * mechanism `mail_fetch_attachments` and `cal_get_event_attachments`
 * already use, so a tool result and its sibling attachment land
 * under the same directory.
 */
function buildHostToolRunContext(
    host: RegisteredPluginTool["hostContext"],
    eventId: string,
    limit: number,
): ToolRunContext {
    return {
        limit,
        spill: async (suggestedName, contents) => {
            const filename = withRandomSuffix(suggestedName);
            const [absPath] = await host.scratch.addFiles(eventId, [{ name: filename, contents }]);
            return absPath;
        },
    };
}

/**
 * Splice a 4-byte hex token into the basename so two concurrent spills
 * with the same `suggestedName` never collide on disk.
 */
function withRandomSuffix(suggestedName: string): string {
    const suffix = randomBytes(4).toString("hex");
    const dotIdx = suggestedName.lastIndexOf(".");
    if (dotIdx <= 0) {
        return `${suggestedName}-${suffix}`;
    }
    return `${suggestedName.slice(0, dotIdx)}-${suffix}${suggestedName.slice(dotIdx)}`;
}

function asMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
