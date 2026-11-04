import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
    type ConfigService,
    DEFAULT_WEBSERVER_HOST,
    DEFAULT_WEBSERVER_PORT,
    type Logger,
} from "@getfamiliar/shared";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";

/** Dependencies of the {@link WebServer}. */
export interface WebServerDeps {
    /** Daemon config; `webserver.*` is read on every {@link WebServer.start}. */
    readonly config: ConfigService;
    /** Logger for lifecycle lines. */
    readonly log: Logger;
}

/** Effective `webserver.*` settings for one start. */
interface WebServerSettings {
    readonly isEnabled: boolean;
    readonly port: number;
    readonly host: string;
}

/**
 * The user-facing web server of the daemon, built on Hono and served
 * through `@hono/node-server`.
 *
 * Deliberately separate from the bastion (`host/src/bastion/HttpServer.ts`):
 * the bastion is the token-gated trust-zone gateway for the agent
 * container, while this server faces the user's browser and will get
 * its own authentication (e.g. Tailscale identity).
 *
 * It starts only when `webserver.enabled` is `true`; `webserver.port`
 * (default {@link DEFAULT_WEBSERVER_PORT}) and `webserver.host`
 * (default {@link DEFAULT_WEBSERVER_HOST}) are read per start, so
 * {@link reload} picks up edits after `familiar config reload`.
 *
 * Planned extension: plugins hand in whole controllers as Hono
 * sub-apps (`ctx.web.registerController(app)`); {@link buildApp}
 * will mount each under `/plugins/<plugin-id>` via `app.route(...)`.
 */
export class WebServer {
    private readonly deps: WebServerDeps;
    private server: Server | null = null;

    /**
     * @param deps Config and logger.
     */
    constructor(deps: WebServerDeps) {
        this.deps = deps;
    }

    /**
     * URL of the bound socket (`http://<host>:<port>`), or `null` while
     * the server is not listening.
     *
     * @returns The listening URL or null.
     */
    get listeningUrl(): string | null {
        if (this.server === null) {
            return null;
        }
        const address = this.server.address() as AddressInfo;
        return `http://${address.address}:${address.port}`;
    }

    /**
     * Start listening when `webserver.enabled` is true; otherwise log
     * that the server is disabled and return. No-op when already running.
     *
     * @throws {Error} When the socket cannot be bound (port in use,
     *   privileged port, bad host); the message names host, port and cause.
     */
    async start(): Promise<void> {
        if (this.server !== null) {
            return;
        }
        const settings = this.readSettings();
        if (!settings.isEnabled) {
            this.deps.log.info("webserver disabled (webserver.enabled is not true)");
            return;
        }
        const server = createAdaptorServer({ fetch: this.buildApp().fetch }) as Server;
        await new Promise<void>((resolve, reject) => {
            server.once("error", (err: NodeJS.ErrnoException) => {
                reject(new Error(describeListenError(err, settings)));
            });
            server.listen(settings.port, settings.host, () => {
                server.removeAllListeners("error");
                resolve();
            });
        });
        server.on("error", (err) => {
            this.deps.log.error(`webserver socket error: ${err.message}`);
        });
        this.server = server;
        this.deps.log.info(`webserver listening on ${this.listeningUrl}`);
    }

    /**
     * Stop listening. Open keep-alive connections are destroyed so the
     * close completes promptly (same reasoning as the bastion's
     * `HttpServer.stop`). No-op when not running.
     */
    async stop(): Promise<void> {
        if (this.server === null) {
            return;
        }
        const server = this.server;
        this.server = null;
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
        this.deps.log.info("webserver stopped");
    }

    /**
     * Apply changed `webserver.*` settings: stop, then start with the
     * current config (which may also mean staying stopped).
     *
     * @throws {Error} When the restart cannot bind the socket.
     */
    async reload(): Promise<void> {
        await this.stop();
        await this.start();
    }

    /**
     * Build the Hono application served by this server.
     *
     * @returns A fresh Hono app.
     */
    private buildApp(): Hono {
        const app = new Hono();
        app.get("/", (c) =>
            c.html(
                '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Familiar</title></head><body><h1>Hello World</h1></body></html>',
            ),
        );
        return app;
    }

    /**
     * Read the effective `webserver.*` settings with defaults.
     *
     * @returns The settings for this start.
     */
    private readSettings(): WebServerSettings {
        const { config } = this.deps;
        return {
            isEnabled: config.getBool("webserver.enabled", false) === true,
            port: config.getNumber("webserver.port", DEFAULT_WEBSERVER_PORT),
            host: config.getString("webserver.host", DEFAULT_WEBSERVER_HOST),
        };
    }
}

/**
 * Turn a `listen` failure into an actionable message.
 *
 * @param err The socket error.
 * @param settings The settings the bind was attempted with.
 * @returns A message naming host, port and the likely fix.
 */
function describeListenError(err: NodeJS.ErrnoException, settings: WebServerSettings): string {
    const target = `${settings.host}:${settings.port}`;
    if (err.code === "EADDRINUSE") {
        return `webserver cannot listen on ${target}: port already in use — choose another webserver.port`;
    }
    if (err.code === "EACCES") {
        return `webserver cannot listen on ${target}: permission denied (ports below 1024 need root or cap_net_bind_service; familiar never runs as root) — choose a webserver.port of 1024 or higher`;
    }
    return `webserver cannot listen on ${target}: ${err.message}`;
}
