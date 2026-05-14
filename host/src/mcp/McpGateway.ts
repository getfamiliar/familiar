import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "effective-assistant-shared";
import type { Bastion, BastionModule } from "../bastion/Bastion.js";
import { DockerMcpRegistryFactory } from "./factories/DockerMcpRegistryFactory.js";
import { ExternalFactory } from "./factories/ExternalFactory.js";
import { NpmFactory } from "./factories/NpmFactory.js";
import { PypiFactory } from "./factories/PypiFactory.js";
import type { McpEntry, McpSource } from "./McpEntry.js";
import type { McpRegistry } from "./McpRegistry.js";
import type { McpServerFactory } from "./McpServerFactory.js";
import { ensureRuntimeImage } from "./RuntimeImages.js";
import type { McpTransport } from "./transports/McpTransport.js";

/** Configuration for the {@link McpGateway} bastion module. */
export interface McpGatewayConfig {
    /**
     * Shared registry of parsed `mcp.yml` entries. Owned by the
     * daemon and passed to both the gateway and the host-side
     * {@link import("./PluginMcpService.js").PluginMcpService} so
     * neither re-parses the file.
     */
    readonly registry: McpRegistry;
    /**
     * Absolute path to the per-MCP log directory
     * (`data/logs/mcp/`). Each stdio MCP gets a daily-rotated
     * `<id>.YYYYMMDD.<n>.log` here for raw stdio capture.
     */
    readonly mcpLogsDir: string;
    /** Days of rotated log retention; mirrors `core.logRetentionDays`. */
    readonly logRetentionDays: number;
    /**
     * Absolute path to the project-root `tmp/` directory; passed
     * through to npm/pypi factories so each MCP gets a per-id bind
     * mount root for `/work`.
     */
    readonly tmpDir: string;
    /** Host UID and GID used as `--user` for npm/pypi runtime containers. */
    readonly hostUid: number;
    readonly hostGid: number;
    /** Logger used for load / dispatch / error lines. */
    readonly log: Logger;
}

/**
 * Bastion module that handles `/mcp/<id>/*`. Loads `mcp.yml` on start,
 * builds one {@link McpTransport} per declared MCP via its source's
 * factory, and dispatches requests by id. The gateway never branches
 * on transport — every transport implements the same interface, and
 * `transport.handle()` does whatever's right (stdio spawn, HTTP
 * forward).
 *
 * Mirrors the shape of `ReverseProxy`: own `start(bastion)` and
 * `stop()`, registers a path prefix on the bastion's HTTP server.
 */
export class McpGateway implements BastionModule {
    readonly name = "mcp-gateway";

    private readonly config: McpGatewayConfig;
    private readonly factories: ReadonlyMap<McpSource, McpServerFactory>;
    private transports: Map<string, McpTransport> = new Map();

    constructor(config: McpGatewayConfig) {
        this.config = config;
        const sharedNpmPypiConfig = {
            log: config.log,
            mcpLogsDir: config.mcpLogsDir,
            logRetentionDays: config.logRetentionDays,
            tmpDir: config.tmpDir,
            hostUid: config.hostUid,
            hostGid: config.hostGid,
        };
        this.factories = new Map<McpSource, McpServerFactory>([
            [
                "docker-mcp-registry",
                new DockerMcpRegistryFactory({
                    log: config.log,
                    mcpLogsDir: config.mcpLogsDir,
                    logRetentionDays: config.logRetentionDays,
                }),
            ],
            ["npm", new NpmFactory(sharedNpmPypiConfig)],
            ["pypi", new PypiFactory(sharedNpmPypiConfig)],
            ["external", new ExternalFactory(config.log)],
        ]);
    }

    async start(bastion: Bastion): Promise<void> {
        const entries = this.config.registry.list();

        // Build only the runtime images that are actually referenced
        // by `mcp.yml`. No npm/pypi entries → no docker-build cost.
        const sources = new Set<McpSource>();
        for (const entry of entries) {
            sources.add(entry.source);
        }
        if (sources.has("npm") || sources.has("pypi")) {
            mkdirSync(this.config.tmpDir, { recursive: true });
        }
        if (sources.has("npm")) {
            await ensureRuntimeImage("npm", this.config.log);
        }
        if (sources.has("pypi")) {
            await ensureRuntimeImage("pypi", this.config.log);
        }

        for (const entry of entries) {
            this.transports.set(entry.id, this.buildTransport(entry));
        }
        bastion.registerPrefix("/mcp/", (req, res, restPath) => {
            return this.dispatch(req, res, restPath);
        });
        const ids = [...this.transports.keys()];
        this.config.log.info(
            ids.length === 0
                ? "mcp-gateway registered /mcp/ for no servers"
                : `mcp-gateway registered /mcp/ for ${ids.length} server${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`,
        );
    }

    async stop(): Promise<void> {
        // Stop transports in parallel so one slow child (an MCP
        // that takes a few seconds to acknowledge EOF) doesn't
        // serialize with the others. Same pattern as
        // `McpClientPool.close` container-side. Per-transport
        // errors are caught locally so one failure can't cancel
        // the others.
        await Promise.allSettled(
            [...this.transports.values()].map(async (transport) => {
                try {
                    await transport.stop();
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.config.log.error(
                        `mcp-gateway transport stop error for '${transport.id}': ${message}`,
                    );
                }
            }),
        );
        this.transports.clear();
    }

    /**
     * Parse `<id>/<rest>` from the trailing path and call the right
     * transport. When the id is empty (the request hit `/mcp/` with
     * nothing after), reply with the catalog. 404 on unknown ids.
     */
    private async dispatch(
        req: IncomingMessage,
        res: ServerResponse,
        restPath: string,
    ): Promise<void> {
        const trimmed = restPath.startsWith("/") ? restPath.slice(1) : restPath;
        const slashIdx = trimmed.indexOf("/");
        const id = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
        const tail = slashIdx === -1 ? "/" : trimmed.slice(slashIdx);
        if (id.length === 0) {
            this.replyCatalog(req, res);
            return;
        }
        const transport = this.transports.get(id);
        if (transport === undefined) {
            replyError(res, 404, `unknown mcp "${id}"`);
            return;
        }
        await transport.handle(req, res, tail);
    }

    /**
     * Reply with the catalog of declared MCPs as a JSON array of
     * `{ id, title, description }`. Used by the agent's
     * `McpClientPool` at boot to discover what to instantiate.
     * Only `GET` is supported; other methods get 405.
     */
    private replyCatalog(req: IncomingMessage, res: ServerResponse): void {
        if (req.method !== "GET") {
            replyError(res, 405, "GET /mcp/ only");
            return;
        }
        const catalog: Array<{ id: string; title: string; description: string }> = [];
        for (const transport of this.transports.values()) {
            catalog.push({
                id: transport.id,
                title: transport.title,
                description: transport.description,
            });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(catalog));
    }

    /** Resolve the source's factory and build a transport from the entry. */
    private buildTransport(entry: McpEntry): McpTransport {
        const factory = this.factories.get(entry.source);
        if (factory === undefined) {
            throw new Error(
                `MCP "${entry.id}": no factory registered for source "${entry.source}".`,
            );
        }
        return factory.create(entry);
    }
}

/** Send a plain-text error response with the given status. */
function replyError(res: ServerResponse, status: number, message: string): void {
    if (!res.headersSent) {
        res.writeHead(status, { "content-type": "text/plain" });
    }
    res.end(message);
}
