import { dockerExec, removeContainer, SHARED_NETWORK_NAME, stopContainer } from "../DockerTools.js";
import type { McpEntry, McpEnvVar } from "./McpEntry.js";

/**
 * Prefix used for all MCP container names. The id from `mcp.yml` is
 * appended to give `ea-mcp-<id>` so the daemon can list and clean up
 * its own containers via `docker ps --filter name=ea-mcp-`.
 */
const CONTAINER_NAME_PREFIX = "ea-mcp-";

/**
 * Concrete base class for every MCP server the daemon manages. Holds
 * the shared lifecycle (idempotent docker run/stop, `ea-net` join,
 * `ea-mcp-<id>` naming, env/volume/args serialization) so that source-
 * specific subclasses only need to supply an image (or override
 * `start`/`stop` entirely, as `ExternalMcpServer` does).
 *
 * The default implementation expects a docker image — subclasses
 * supply it via the protected `image` getter. Non-docker sources
 * (e.g. external HTTP MCPs) override `start`/`stop` to no-ops; they
 * inherit the metadata fields but skip the docker machinery.
 */
export class McpServer {
    /** Stable identifier from `mcp.yml`; also forms the container name. */
    readonly id: string;
    /** Short human-facing title for listings. */
    readonly title: string;
    /** Longer human-facing description for listings. */
    readonly description: string;

    protected readonly entry: McpEntry;
    private running = false;

    constructor(entry: McpEntry) {
        this.id = entry.id;
        this.title = entry.title;
        this.description = entry.description;
        this.entry = entry;
    }

    /** True if `start()` has succeeded and `stop()` has not yet been called. */
    get isRunning(): boolean {
        return this.running;
    }

    /** Container name this server runs under, e.g. `ea-mcp-fetch`. */
    get containerName(): string {
        return `${CONTAINER_NAME_PREFIX}${this.id}`;
    }

    /**
     * Image reference to run. The default implementation throws —
     * subclasses that drive a docker container override this. Kept as
     * a method (not a constructor arg) so subclasses can compute it
     * from the entry (e.g. npm/pypi factories synthesize an image tag
     * from the package name).
     */
    protected get image(): string {
        throw new Error(
            `McpServer "${this.id}": image not configured (source "${this.entry.source}" is not implemented).`,
        );
    }

    /**
     * Start the MCP container detached on `ea-net`. Idempotent against
     * stale containers from a previous crash: any container with the
     * same name is removed first.
     */
    async start(): Promise<void> {
        await removeContainer(this.containerName);
        await dockerExec(this.buildRunArgs());
        this.running = true;
    }

    /**
     * Stop and remove the MCP container. SIGTERM-equivalent; defaults
     * to docker's 10 s grace period. Safe to call when not running.
     */
    async stop(): Promise<void> {
        if (!this.running) {
            return;
        }
        await stopContainer(this.containerName);
        await removeContainer(this.containerName);
        this.running = false;
    }

    /**
     * Build the `docker run` arg vector. Order: `run -d --name <name>
     * --network <ea-net> [--entrypoint <command>] [-e KEY=VAL …]
     * [-v HOST:CONTAINER[:ro] …] <image> [args …]`. Network mode
     * follows the entry's `network.disable` flag.
     */
    private buildRunArgs(): string[] {
        const args: string[] = ["run", "-d", "--name", this.containerName];

        if (this.entry.network.disable) {
            args.push("--network", "none");
        } else {
            args.push("--network", SHARED_NETWORK_NAME);
        }

        if (this.entry.command !== null) {
            args.push("--entrypoint", this.entry.command);
        }

        for (const env of this.entry.env) {
            args.push("-e", formatEnv(env));
        }
        for (const volume of this.entry.volumes) {
            args.push("-v", volume);
        }

        args.push(this.image);

        for (const a of this.entry.args) {
            args.push(a);
        }

        return args;
    }
}

/** `KEY=VALUE` form expected by `docker run -e`. */
function formatEnv(env: McpEnvVar): string {
    return `${env.name}=${env.value}`;
}
