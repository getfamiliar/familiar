import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "effective-assistant-shared";
import type { Bastion, BastionModule } from "../bastion/Bastion.js";
import { DockerMcpRegistryFactory } from "./factories/DockerMcpRegistryFactory.js";
import { ExternalFactory } from "./factories/ExternalFactory.js";
import { NpmFactory } from "./factories/NpmFactory.js";
import { PypiFactory } from "./factories/PypiFactory.js";
import { loadMcpEntries } from "./McpConfigLoader.js";
import type { McpEntry, McpSource } from "./McpEntry.js";
import type { McpServerFactory } from "./McpServerFactory.js";
import type { McpTransport } from "./transports/McpTransport.js";

/** Configuration for the {@link McpGateway} bastion module. */
export interface McpGatewayConfig {
    /** Absolute path to `config/mcp.yml`. */
    readonly mcpConfigFile: string;
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
        this.factories = new Map<McpSource, McpServerFactory>([
            ["docker-mcp-registry", new DockerMcpRegistryFactory(config.log)],
            ["npm", new NpmFactory()],
            ["pypi", new PypiFactory()],
            ["external", new ExternalFactory(config.log)],
        ]);
    }

    async start(bastion: Bastion): Promise<void> {
        const entries = loadMcpEntries(this.config.mcpConfigFile, this.config.log);
        for (const entry of entries.values()) {
            this.transports.set(entry.id, this.buildTransport(entry));
        }
        bastion.registerPrefix("/mcp/", (req, res, restPath) => {
            return this.dispatch(req, res, restPath);
        });
        this.config.log.info({ mcps: [...this.transports.keys()] }, "mcp-gateway registered /mcp/");
    }

    async stop(): Promise<void> {
        for (const transport of this.transports.values()) {
            try {
                await transport.stop();
            } catch (err) {
                this.config.log.error(
                    {
                        mcp: transport.id,
                        err: err instanceof Error ? err.message : String(err),
                    },
                    "mcp-gateway transport stop error",
                );
            }
        }
        this.transports.clear();
    }

    /**
     * Parse `<id>/<rest>` from the trailing path and call the right
     * transport. Replies 404 for unknown ids, 400 for malformed paths.
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
            replyError(res, 400, "expected /mcp/<id>/<rest>");
            return;
        }
        const transport = this.transports.get(id);
        if (transport === undefined) {
            replyError(res, 404, `unknown mcp "${id}"`);
            return;
        }
        await transport.handle(req, res, tail);
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
