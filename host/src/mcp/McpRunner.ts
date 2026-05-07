import type { Logger } from "effective-assistant-shared";
import { DockerMcpRegistryFactory } from "./factories/DockerMcpRegistryFactory.js";
import { ExternalFactory } from "./factories/ExternalFactory.js";
import { NpmFactory } from "./factories/NpmFactory.js";
import { PypiFactory } from "./factories/PypiFactory.js";
import { loadMcpEntries } from "./McpConfigLoader.js";
import type { McpEntry, McpSource } from "./McpEntry.js";
import type { McpServer } from "./McpServer.js";
import type { McpServerFactory } from "./McpServerFactory.js";

/** Configuration for {@link McpRunner}. */
export interface McpRunnerConfig {
    /** Absolute host path to `config/mcp.yml`. */
    readonly configFile: string;
    /** Logger child the runner writes lifecycle events to. */
    readonly log: Logger;
}

/**
 * Fleet manager for MCP-server containers. Symmetric to the other
 * container runners (`PostgresContainer`, `AgentContainer`,
 * `ReverseProxyContainer`) — exposes `start()`/`stop()`/`isRunning`
 * — but manages an N-element fleet read from `config/mcp.yml` instead
 * of one fixed container.
 *
 * Lifecycle: `start()` parses the config, dispatches each entry to
 * the matching {@link McpServerFactory}, and starts each server in
 * declaration order. `stop()` reverses the order. Failures during
 * start abort the rest of the sequence; failures during stop are
 * logged and skipped so every server gets a chance to clean up.
 *
 * MCPs are not yet wired into the agent's tool layer — this runner
 * brings the containers up and keeps them running, but nothing reads
 * from them yet. That wiring lands in a follow-up step.
 */
export class McpRunner {
    private readonly configFile: string;
    private readonly log: Logger;
    private readonly factories: ReadonlyMap<McpSource, McpServerFactory>;
    private servers: McpServer[] = [];
    private running = false;

    constructor(config: McpRunnerConfig) {
        this.configFile = config.configFile;
        this.log = config.log;
        this.factories = new Map<McpSource, McpServerFactory>([
            ["docker-mcp-registry", new DockerMcpRegistryFactory()],
            ["npm", new NpmFactory()],
            ["pypi", new PypiFactory()],
            ["external", new ExternalFactory()],
        ]);
    }

    /** True once `start()` has populated the fleet and not yet been stopped. */
    get isRunning(): boolean {
        return this.running;
    }

    /**
     * Load `mcp.yml`, build server instances via factories, and start
     * each one in declaration order. A `mcp.yml` that is absent or
     * empty is a valid configuration: no MCPs run.
     */
    async start(): Promise<void> {
        const entries = loadMcpEntries(this.configFile, this.log);
        if (entries.size === 0) {
            this.log.info("no MCPs declared");
            this.running = true;
            return;
        }

        this.servers = [];
        for (const entry of entries.values()) {
            this.servers.push(this.buildServer(entry));
        }

        for (const server of this.servers) {
            await server.start();
            this.log.info({ mcp: server.id, container: server.containerName }, "mcp started");
        }
        this.running = true;
    }

    /**
     * Stop every running server in reverse order. One failure does
     * not abort the rest — the runner still tries to stop the others
     * so the daemon doesn't leak containers.
     */
    async stop(): Promise<void> {
        if (!this.running) {
            return;
        }
        for (let i = this.servers.length - 1; i >= 0; i--) {
            const server = this.servers[i];
            try {
                await server.stop();
                this.log.info({ mcp: server.id }, "mcp stopped");
            } catch (err) {
                this.log.error(
                    {
                        mcp: server.id,
                        err: err instanceof Error ? err.message : String(err),
                    },
                    "mcp stop error",
                );
            }
        }
        this.servers = [];
        this.running = false;
    }

    /**
     * Dispatch a single entry to its source's factory. Throws when
     * the source is unknown — should never happen given lint coverage,
     * but the message is explicit if it does.
     */
    private buildServer(entry: McpEntry): McpServer {
        const factory = this.factories.get(entry.source);
        if (factory === undefined) {
            throw new Error(
                `MCP "${entry.id}": no factory registered for source "${entry.source}".`,
            );
        }
        return factory.create(entry);
    }
}
