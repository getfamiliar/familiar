import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_WEBSERVER_HOST, DEFAULT_WEBSERVER_PORT, type Logger } from "@getfamiliar/shared";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { html } from "hono/html";
import type { HostConfigService } from "../utils/ConfigService.js";
import type { TrustedProxyRegistry } from "./auth/TrustedProxyRegistry.js";
import {
    createAuthMiddleware,
    mountLoginRoutes,
    page,
    readWebAuthSettings,
    type WebAuthDeps,
    type WebEnv,
} from "./auth/WebAuth.js";
import type { WebSessionStore } from "./auth/WebSessionStore.js";

/** Dependencies of the {@link WebServer}. */
export interface WebServerDeps {
    /** Daemon config; `webserver.*` is read on every {@link WebServer.start}. */
    readonly config: HostConfigService;
    /** Logger for lifecycle lines. */
    readonly log: Logger;
    /** Trusted proxies; the config-defined ones are replaced on every start. */
    readonly trustedProxies: TrustedProxyRegistry;
    /** Login tokens and sessions. */
    readonly sessions: WebSessionStore;
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
 * container, while this server faces the user's browser. Every route
 * sits behind the auth middleware (`./auth/WebAuth.ts`): a trusted
 * proxy's user header (proven by its shared secret) or a session from a
 * `familiar web login` link, checked against `webserver.auth.users`.
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
     * @throws {Error} When `webserver.auth` is unusable (no allowed users,
     *   malformed trusted proxy) or the socket cannot be bound (port in
     *   use, privileged port, bad host); the message names the cause.
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
        const auth = readWebAuthSettings(this.deps.config);
        this.deps.trustedProxies.setConfigProxies(auth.configProxies);
        const app = this.buildApp({
            settings: auth,
            proxies: this.deps.trustedProxies,
            sessions: this.deps.sessions,
            log: this.deps.log,
        });
        const server = createAdaptorServer({ fetch: app.fetch }) as Server;
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
        const proxyIds = this.deps.trustedProxies.listIds();
        this.deps.log.info(
            `webserver listening on ${this.listeningUrl} — allowed users: ${auth.users.join(", ")}; trusted proxies: ${proxyIds.length === 0 ? "none" : proxyIds.join(", ")}`,
        );
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
     * Build the Hono application served by this server: the auth
     * middleware in front of everything, the login routes, then the pages.
     *
     * @param auth Auth settings and stores for this start.
     * @returns A fresh Hono app.
     */
    private buildApp(auth: WebAuthDeps): Hono<WebEnv> {
        const app = new Hono<WebEnv>();
        app.use(createAuthMiddleware(auth));
        mountLoginRoutes(app, auth);
        app.get("/", (c) => {
            const principal = c.get("principal");
            return c.html(
                page(
                    "Hello World",
                    html`<p>Signed in as ${principal.displayName} (${principal.login}, via ${principal.via}).</p>
                        <form method="post" action="/logout"><button type="submit">Sign out</button></form>`,
                ),
            );
        });
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
