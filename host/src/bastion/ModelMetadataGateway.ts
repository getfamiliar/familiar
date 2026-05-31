import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger, ModelMetaData } from "@getfamiliar/shared";
import type { ModelMetadataService } from "../models/ModelMetadataService.js";
import type { Bastion, BastionModule } from "./Bastion.js";

/** URL prefix the gateway claims on the bastion's HTTP server. */
const PREFIX = "/model-metadata/";

/** Configuration for the {@link ModelMetadataGateway} bastion module. */
export interface ModelMetadataGatewayConfig {
    /** Host-side metadata source (models.dev + plugin fallback). */
    readonly service: ModelMetadataService;
    /** Logger child for gateway lifecycle and lookup lines. */
    readonly log: Logger;
}

/** Response body shape served by `POST /model-metadata/`. */
export interface ModelMetadataResponse {
    /** Resolved metadata, or `null` when no source knows the model. */
    readonly meta: ModelMetaData | null;
}

/**
 * Bastion module the container calls when an agentrun starts to learn
 * its model's capabilities. Mirrors
 * {@link import("./EventContextGateway.js").EventContextGateway} in
 * shape: claims a single prefix, accepts JSON POSTs, returns a clean
 * payload on the wire.
 *
 * Wire-level invariants:
 *
 * - POST `/model-metadata/` with body `{ provider, model }` resolves via
 *   {@link ModelMetadataService.lookup}.
 * - 200 with `{ meta }` on success; `{ meta: null }` is valid (the model
 *   is simply unknown to every source).
 * - 405 for non-POST, 400 for a malformed body.
 * - A lookup that throws degrades to `{ meta: null }` (best-effort) — the
 *   container treats missing metadata as non-fatal, so a gateway error
 *   must not block agentrun start.
 * - The bastion isn't authenticated; same trust model as `/mcp/`,
 *   `/plugin-tools/`, and `/event-context/`.
 */
export class ModelMetadataGateway implements BastionModule {
    readonly name = "model-metadata-gateway";

    private readonly service: ModelMetadataService;
    private readonly log: Logger;

    constructor(config: ModelMetadataGatewayConfig) {
        this.service = config.service;
        this.log = config.log;
    }

    async start(bastion: Bastion): Promise<void> {
        bastion.registerPrefix(PREFIX, (req, res) => this.dispatch(req, res));
        this.log.info(`model-metadata-gateway registered ${PREFIX}`);
    }

    async stop(): Promise<void> {
        // No resources of our own — the service and HTTP server are
        // owned elsewhere.
    }

    /**
     * Single-route dispatch. Only `POST /model-metadata/` is accepted.
     */
    private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method !== "POST") {
            replyHttpError(res, 405, "POST /model-metadata/ only");
            return;
        }
        let body: InvokeBody;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            replyHttpError(res, 400, asMessage(err));
            return;
        }
        if (typeof body.provider !== "string" || body.provider.length === 0) {
            replyHttpError(res, 400, "missing provider");
            return;
        }
        if (typeof body.model !== "string" || body.model.length === 0) {
            replyHttpError(res, 400, "missing model");
            return;
        }

        let meta: ModelMetaData | undefined;
        try {
            meta = await this.service.lookup(body.provider, body.model);
        } catch (err) {
            this.log.warn(
                { provider: body.provider, model: body.model, err: asMessage(err) },
                `model-metadata lookup failed for ${body.provider}/${body.model}`,
            );
            meta = undefined;
        }

        const responseBody: ModelMetadataResponse = { meta: meta ?? null };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseBody));
    }
}

/** POST body shape. */
interface InvokeBody {
    readonly provider: unknown;
    readonly model: unknown;
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

function replyHttpError(res: ServerResponse, status: number, message: string): void {
    if (!res.headersSent) {
        res.writeHead(status, { "content-type": "text/plain" });
    }
    res.end(message);
}

function asMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
