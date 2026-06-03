import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ContainerToolInfo, Logger } from "@getfamiliar/shared";
import type { Bastion, BastionModule } from "../bastion/Bastion.js";
import type { ContainerToolsRegistry } from "./ContainerToolsRegistry.js";

/** URL prefix the gateway claims on the bastion's HTTP server. */
const PREFIX = "/container-tools/";

/** Configuration for the {@link ContainerToolsGateway} bastion module. */
export interface ContainerToolsGatewayConfig {
    /**
     * Registry the gateway writes on each container report and the rest
     * of the host reads. Held by reference so a report after {@link start}
     * — the normal case, since the container reports once it's up — is
     * visible to subsequent `GET`s.
     */
    readonly registry: ContainerToolsRegistry;
    /** Logger child for gateway lifecycle and report lines. */
    readonly log: Logger;
}

/**
 * Bastion module serving the container's built-in tool catalog:
 * `POST /container-tools/` (the agent container reports its catalog on
 * startup) and `GET /container-tools/` (the host reads it back, for the
 * `tools list` CLI). Modeled on {@link import("../plugins/ToolsGateway.js").PluginToolsGateway}
 * and {@link import("../mcp/McpGateway.js").McpGateway} — registers a
 * prefix, dispatches by method, returns clean errors.
 *
 * Unlike the plugin-tools gateway the data flows container→host: the
 * container is the authority on its own built-ins, so the host merely
 * caches the latest report. Same trust model as `/plugin-tools/` and
 * `/mcp/` — the bastion is unauthenticated and the agent container is
 * the only expected client.
 */
export class ContainerToolsGateway implements BastionModule {
    readonly name = "container-tools-gateway";

    private readonly config: ContainerToolsGatewayConfig;

    constructor(config: ContainerToolsGatewayConfig) {
        this.config = config;
    }

    async start(bastion: Bastion): Promise<void> {
        bastion.registerPrefix(PREFIX, (req, res) => this.dispatch(req, res));
        this.config.log.info(`container-tools-gateway registered ${PREFIX}`);
    }

    async stop(): Promise<void> {
        // No resources to release — the registry is plain in-memory state
        // owned by the daemon, and the HTTP server is owned by the bastion.
    }

    /**
     * `GET /container-tools/` replies with the last-reported catalog;
     * `POST /container-tools/` replaces it with the request body. Any
     * other method gets 405.
     */
    private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(this.config.registry.list()));
            return;
        }
        if (req.method === "POST") {
            await this.ingest(req, res);
            return;
        }
        replyError(res, 405, "GET or POST /container-tools/ only");
    }

    /**
     * Read the JSON body — an array of {@link ContainerToolInfo} — and
     * replace the registry's catalog with it. A malformed body is a
     * caller (container) bug; reply 400 and leave the previous catalog
     * intact.
     */
    private async ingest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        let parsed: unknown;
        try {
            parsed = await readJsonBody(req);
        } catch (err) {
            replyError(res, 400, err instanceof Error ? err.message : String(err));
            return;
        }
        if (!Array.isArray(parsed)) {
            replyError(res, 400, "container-tools report body must be a JSON array");
            return;
        }
        const tools = parsed.filter(isContainerToolInfo);
        this.config.registry.replace(tools);
        this.config.log.info(`container reported ${tools.length} built-in tools`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ stored: tools.length }));
    }
}

/** Narrow a parsed array element to {@link ContainerToolInfo}. */
function isContainerToolInfo(value: unknown): value is ContainerToolInfo {
    if (value === null || typeof value !== "object") {
        return false;
    }
    const obj = value as Record<string, unknown>;
    return (
        typeof obj.name === "string" &&
        typeof obj.description === "string" &&
        typeof obj.inputSchema === "object" &&
        obj.inputSchema !== null &&
        Array.isArray(obj.groups)
    );
}

/**
 * Read the request stream to completion and parse JSON. Rejects empty
 * bodies — a report with no body is a caller bug, not an empty catalog
 * (which would arrive as `[]`).
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) {
        throw new Error("empty request body");
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Plain-text protocol-level error with a real HTTP status. */
function replyError(res: ServerResponse, status: number, message: string): void {
    if (!res.headersSent) {
        res.writeHead(status, { "content-type": "text/plain" });
    }
    res.end(message);
}
