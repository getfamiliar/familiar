import type { Logger } from "@getfamiliar/shared";
import { HttpServer, type PrefixHandler } from "./HttpServer.js";

/**
 * Default port the bastion HTTP server listens on. Inherited from the
 * old reverse-proxy container so existing references stay valid; can
 * be overridden via the {@link BastionConfig}.
 */
const DEFAULT_PORT = 8788;

/**
 * A module that wires itself into the bastion. Both the LLM
 * reverse-proxy and the MCP gateway implement this. Modules **register
 * their own routes** during `start(bastion)` rather than the bastion
 * knowing about them — keeps the bastion ignorant of its peers.
 */
export interface BastionModule {
    /** Short name for log lines (`reverse-proxy`, `mcp-gateway`). */
    readonly name: string;
    /**
     * Called after the HTTP server is listening. Modules use the bastion's
     * {@link Bastion.registerPrefix} to claim path prefixes.
     */
    start(bastion: Bastion): Promise<void>;
    /** Called during daemon shutdown. May release resources. */
    stop(): Promise<void>;
}

/** Configuration for the {@link Bastion}. */
export interface BastionConfig {
    /** Port to listen on. Defaults to {@link DEFAULT_PORT}. */
    readonly port?: number;
    /** Logger used for lifecycle events. */
    readonly log: Logger;
    /** Modules wired in by the daemon, in the order they should start. */
    readonly modules: readonly BastionModule[];
}

/**
 * Address the bastion binds on. `0.0.0.0` is portable across native
 * Linux and Docker Desktop / WSL2 (where the docker bridge IP isn't
 * directly bindable from the host process). The agent reaches the
 * bastion via `host.docker.internal` — the {@link AgentContainer}
 * already adds `--add-host=host.docker.internal:host-gateway` on
 * Linux so the name resolves to the host. Operators concerned about
 * LAN exposure should firewall this port externally.
 */
const BIND_HOST = "0.0.0.0";

/**
 * URL the agent uses to reach the bastion. Resolved by Docker via
 * `host.docker.internal:host-gateway` regardless of host OS, so the
 * advertised string is the same on Linux, macOS, and Windows.
 */
const ADVERTISED_HOST = "host.docker.internal";

/**
 * Slim host-side service the agent container talks to for everything
 * privileged: LLM provider proxying with auth injection, and the MCP
 * gateway that spawns/forwards on-demand. The bastion itself owns only
 * lifecycle, the {@link HttpServer}, and the route-registration API.
 * Each peer module (reverse proxy, MCP gateway) lives elsewhere and
 * registers itself during its own `start`.
 *
 * Binds on `0.0.0.0` for portability (the docker bridge IP isn't
 * bindable on WSL2/Docker Desktop). The agent reaches it as
 * `http://host.docker.internal:<port>`; that URL is exposed as
 * `BASTION_URL`.
 */
export class Bastion {
    private readonly config: BastionConfig;
    private readonly port: number;
    private httpServer: HttpServer | null = null;
    private startedModules: BastionModule[] = [];

    constructor(config: BastionConfig) {
        this.config = config;
        this.port = config.port ?? DEFAULT_PORT;
    }

    /**
     * Port the bastion listens on. Needed by the bastion-bridge sidecar,
     * which listens on the same port and forwards to the host bastion.
     */
    get listenPort(): number {
        return this.port;
    }

    /**
     * Stable URL the agent container should be told to dial. Available
     * after {@link start} resolves.
     */
    get url(): string {
        if (this.httpServer === null) {
            throw new Error("bastion not started yet");
        }
        return `http://${ADVERTISED_HOST}:${this.port}`;
    }

    /**
     * URL host-side callers (e.g. plugins reaching MCPs via the
     * gateway) use to dial the bastion. `host.docker.internal`
     * (exposed via {@link url}) only resolves inside the agent
     * container, so host-side code must use the loopback address.
     * Both URLs reach the same `0.0.0.0`-bound listener.
     */
    get loopbackUrl(): string {
        if (this.httpServer === null) {
            throw new Error("bastion not started yet");
        }
        return `http://127.0.0.1:${this.port}`;
    }

    /**
     * Start the listening socket, then start each registered module so
     * it can register its own routes. If any module's start throws, the
     * already-started modules are stopped in reverse order.
     */
    async start(): Promise<void> {
        this.httpServer = new HttpServer({
            bindHost: BIND_HOST,
            port: this.port,
            log: this.config.log,
        });
        await this.httpServer.start();

        try {
            for (const module of this.config.modules) {
                await module.start(this);
                this.startedModules.push(module);
                this.config.log.info(`bastion module started: ${module.name}`);
            }
        } catch (err) {
            await this.unwindModules();
            await this.httpServer.stop();
            this.httpServer = null;
            throw err;
        }
    }

    /**
     * Stop modules in reverse start order, then close the HTTP server.
     * One module's stop failing does not abort the rest — every module
     * gets a chance to drain.
     */
    async stop(): Promise<void> {
        await this.unwindModules();
        if (this.httpServer !== null) {
            await this.httpServer.stop();
            this.httpServer = null;
        }
    }

    /**
     * Register a path-prefix handler with the bastion's HTTP server.
     * Modules call this from their own `start(bastion)` to claim
     * `/llm/`, `/mcp/`, …
     */
    registerPrefix(prefix: string, handler: PrefixHandler): void {
        if (this.httpServer === null) {
            throw new Error("bastion HTTP server not running");
        }
        this.httpServer.registerPrefix(prefix, handler);
    }

    /** Walk started modules in reverse, swallowing per-module errors. */
    private async unwindModules(): Promise<void> {
        for (let i = this.startedModules.length - 1; i >= 0; i--) {
            const module = this.startedModules[i];
            try {
                await module.stop();
            } catch (err) {
                this.config.log.error(
                    {
                        module: module.name,
                        err: err instanceof Error ? err.message : String(err),
                    },
                    "bastion module stop error",
                );
            }
        }
        this.startedModules = [];
    }
}
