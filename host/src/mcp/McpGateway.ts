import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "@getfamiliar/shared";
import type { Bootstrap } from "../Bootstrap.js";
import type { Bastion, BastionModule } from "../bastion/Bastion.js";
import { DockerMcpRegistryFactory } from "./factories/DockerMcpRegistryFactory.js";
import { ExternalFactory } from "./factories/ExternalFactory.js";
import { NpmFactory } from "./factories/NpmFactory.js";
import { PypiFactory } from "./factories/PypiFactory.js";
import type { McpEntry, McpSource } from "./McpEntry.js";
import type { McpDiff, McpRegistry } from "./McpRegistry.js";
import type { McpServerFactory } from "./McpServerFactory.js";
import { ensureRuntimeImage, inspectRuntimeImageId } from "./RuntimeImages.js";
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
    /**
     * Absolute path of `tmp/scratch/`. Bind-mounted at `/scratch`
     * inside every MCP so the agent and all MCPs share one scratch
     * namespace by absolute path. See AgentContainer for the
     * matching agent-side mount.
     */
    readonly scratchDir: string;
    /** Host UID and GID used as `--user` for npm/pypi runtime containers. */
    readonly hostUid: number;
    readonly hostGid: number;
    /**
     * Bootstrap, forwarded to {@link ensureRuntimeImage} so npm/pypi
     * runtime images follow the same build-vs-pull policy as the agent
     * and bridge images.
     */
    readonly boot: Bootstrap;
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
    /**
     * Per-id transport generation, served on the catalog. Bumped every
     * time {@link applyDiff} rebuilds or adds a transport, so the
     * container's client pool knows which sessions are stale and must
     * reconnect (a fresh stdio child has not seen their `initialize`).
     */
    private readonly generations = new Map<string, number>();
    private nextGeneration = 1;
    /**
     * Runtime image ids, filled by {@link start} right after
     * `ensureRuntimeImage` and before any transport is built. The
     * npm/pypi factories stamp offline caches with them.
     */
    private readonly runtimeImageIds = new Map<"npm" | "pypi", string>();

    constructor(config: McpGatewayConfig) {
        this.config = config;
        const sharedRuntimeConfig = {
            log: config.log,
            mcpLogsDir: config.mcpLogsDir,
            logRetentionDays: config.logRetentionDays,
            tmpDir: config.tmpDir,
            scratchDir: config.scratchDir,
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
                    scratchDir: config.scratchDir,
                }),
            ],
            [
                "npm",
                new NpmFactory({
                    ...sharedRuntimeConfig,
                    resolveRuntimeImageId: () => this.runtimeImageIdFor("npm"),
                }),
            ],
            [
                "pypi",
                new PypiFactory({
                    ...sharedRuntimeConfig,
                    resolveRuntimeImageId: () => this.runtimeImageIdFor("pypi"),
                }),
            ],
            ["external", new ExternalFactory(config.log)],
        ]);
    }

    /**
     * The runtime image id recorded by {@link start}.
     *
     * @param source The MCP runtime flavor.
     * @returns The image id.
     * @throws When called before {@link start} ensured that image —
     *   i.e. a transport for a source no `mcp.yml` entry referenced.
     */
    private runtimeImageIdFor(source: "npm" | "pypi"): string {
        const id = this.runtimeImageIds.get(source);
        if (id === undefined) {
            throw new Error(
                `mcp runtime image for "${source}" was not ensured before building a transport`,
            );
        }
        return id;
    }

    async start(bastion: Bastion): Promise<void> {
        const entries = this.config.registry.list();

        // Build only the runtime images that are actually referenced
        // by `mcp.yml`. No npm/pypi entries → no docker-build cost.
        await this.ensureRuntimeImagesFor(entries);

        for (const entry of entries) {
            this.installTransport(entry);
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

    /**
     * Apply a reload of `mcp.yml` (the registry already holds the new
     * entries): stop and drop the transports of removed ids, rebuild
     * changed ones and build added ones. Unchanged ids keep their
     * transport instance — and with it their cached `initialize`
     * handshake — so connected clients stay valid.
     *
     * A request still in flight on a replaced transport is cut off when
     * that transport stops; the next request reaches the new one.
     * During the swap the affected ids answer 404.
     *
     * @param diff What the registry reload changed.
     * @throws If ensuring a newly referenced runtime image fails; nothing
     *   has been swapped at that point.
     */
    async applyDiff(diff: McpDiff): Promise<void> {
        const rebuilt = [...diff.added, ...diff.changed];
        const entries = rebuilt
            .map((id) => this.config.registry.get(id))
            .filter((entry): entry is McpEntry => entry !== undefined);
        await this.ensureRuntimeImagesFor(entries);

        const retired: McpTransport[] = [];
        for (const id of [...diff.removed, ...diff.changed]) {
            const transport = this.transports.get(id);
            if (transport !== undefined) {
                retired.push(transport);
            }
            this.transports.delete(id);
            this.generations.delete(id);
        }
        // Stop before installing: a rebuilt stdio transport spawns its
        // container under the same `familiar-mcp-<id>` name, which must
        // be gone first. Requests in the gap get a 404 for the id.
        await this.stopTransports(retired);
        for (const entry of entries) {
            this.installTransport(entry);
        }
        if (diff.added.length + diff.removed.length + diff.changed.length > 0) {
            this.config.log.info(
                `mcp-gateway reloaded: added [${diff.added.join(", ")}], removed [${diff.removed.join(", ")}], changed [${diff.changed.join(", ")}]`,
            );
        }
    }

    /**
     * Build the npm / pypi runtime images the given entries need and
     * that are not ensured yet. No npm/pypi entries → no docker-build cost.
     *
     * @param entries Entries about to get a transport.
     */
    private async ensureRuntimeImagesFor(entries: readonly McpEntry[]): Promise<void> {
        for (const source of ["npm", "pypi"] as const) {
            if (this.runtimeImageIds.has(source) || !entries.some((e) => e.source === source)) {
                continue;
            }
            mkdirSync(this.config.tmpDir, { recursive: true });
            await ensureRuntimeImage(source, this.config.boot, this.config.log);
            this.runtimeImageIds.set(source, await inspectRuntimeImageId(source));
        }
    }

    /**
     * Build a transport for `entry`, store it and give it a fresh generation.
     *
     * @param entry The entry to serve.
     */
    private installTransport(entry: McpEntry): void {
        this.transports.set(entry.id, this.buildTransport(entry));
        this.generations.set(entry.id, this.nextGeneration++);
    }

    async stop(): Promise<void> {
        await this.stopTransports([...this.transports.values()]);
        this.transports.clear();
        this.generations.clear();
    }

    /**
     * Stop transports in parallel so one slow child (an MCP that takes a
     * few seconds to acknowledge EOF) doesn't serialize with the others.
     * Same pattern as `McpClientPool.close` container-side. Per-transport
     * errors are caught locally so one failure can't cancel the others.
     *
     * @param transports The transports to stop.
     */
    private async stopTransports(transports: readonly McpTransport[]): Promise<void> {
        await Promise.allSettled(
            transports.map(async (transport) => {
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
     * `{ id, title, description, allowlist, denylist, approval, privileged, generation }`.
     * `generation` changes whenever the id's transport is rebuilt by a
     * reload, telling the container pool to reconnect that client.
     * Used by the agent's `McpClientPool` at boot to discover what to
     * instantiate and how to gate each MCP's tools (the four glob lists
     * are resolved container-side). Only `GET` is supported; other
     * methods get 405.
     */
    private replyCatalog(req: IncomingMessage, res: ServerResponse): void {
        if (req.method !== "GET") {
            replyError(res, 405, "GET /mcp/ only");
            return;
        }
        const catalog: Array<{
            id: string;
            title: string;
            description: string;
            allowlist: readonly string[];
            denylist: readonly string[];
            approval: readonly string[];
            privileged: readonly string[];
            generation: number;
        }> = [];
        for (const transport of this.transports.values()) {
            const entry = this.config.registry.get(transport.id);
            catalog.push({
                id: transport.id,
                title: transport.title,
                description: transport.description,
                allowlist: entry?.allowlist ?? [],
                denylist: entry?.denylist ?? [],
                approval: entry?.approval ?? [],
                privileged: entry?.privileged ?? [],
                generation: this.generations.get(transport.id) ?? 0,
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
