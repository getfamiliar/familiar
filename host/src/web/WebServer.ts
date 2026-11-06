import { type IncomingMessage, type Server, STATUS_CODES } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
    DEFAULT_WEBSERVER_HOST,
    DEFAULT_WEBSERVER_PORT,
    type Logger,
    webPluginBasePath,
} from "@getfamiliar/shared";
import { createAdaptorServer, type Http2Bindings, type HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { html } from "hono/html";
import { type WebSocket, WebSocketServer } from "ws";
import type { HostConfigService } from "../utils/ConfigService.js";
import type { TrustedProxyRegistry } from "./auth/TrustedProxyRegistry.js";
import {
    authenticateUpgrade,
    createAuthMiddleware,
    mountLoginRoutes,
    page,
    readWebAuthSettings,
    type WebAuthDeps,
    type WebEnv,
} from "./auth/WebAuth.js";
import type { WebSessionStore } from "./auth/WebSessionStore.js";
import type { RegisteredWebSocket, WebPluginRegistry } from "./WebPluginRegistry.js";
import type { WebUiRegistry, WebUiSelection } from "./WebUiRegistry.js";
import { WsPeer } from "./WsPeer.js";

/** Largest WebSocket frame a plugin socket accepts (1 MiB). */
const MAX_SOCKET_FRAME_BYTES = 1024 * 1024;

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
    /** Web UI root controllers provided by plugins; a change rebuilds the app. */
    readonly webUis: WebUiRegistry;
    /** Plugin controllers mounted at `/plugins/<plugin-id>`; a change rebuilds the app. */
    readonly webPlugins: WebPluginRegistry;
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
 * Plugin controllers (`webPlugin(ctx)`) are mounted at `/plugins/<plugin-id>`.
 * The pages themselves come from a web UI plugin: its `webUi(ctx)`
 * root controller (plus, optionally, the markup of the login pages, whose
 * logic stays here) (selected by {@link WebUiRegistry.select}, pinned via
 * `webserver.uiPlugin`) is mounted at `/` behind the auth middleware and
 * the login routes. Without one, a plain page asks to install a web UI
 * plugin. When the registered controllers change (plugin restart), the
 * app is rebuilt in place without rebinding the socket.
 *
 * Plugin WebSocket endpoints (`WebPluginUi.sockets`) are served from the
 * node server's `upgrade` event, which never reaches the Hono app: each
 * handshake is authenticated by {@link authenticateUpgrade} (same rules
 * as the middleware plus a mandatory same-origin `Origin`). Open sockets
 * of a plugin are closed when it re-registers or unregisters, and all of
 * them when the server stops.
 */
export class WebServer {
    private readonly deps: WebServerDeps;
    private server: Server | null = null;
    /** App currently answering requests; swapped by {@link rebuildApp}. */
    private app: Hono<WebEnv> | null = null;
    /** Auth deps of the current start, reused by {@link rebuildApp}. */
    private authDeps: WebAuthDeps | null = null;
    /** Unsubscribe from {@link WebServerDeps.webUis} and {@link WebServerDeps.webPlugins} changes. */
    private unsubscribeRegistries: (() => void) | null = null;
    /** Accepts plugin WebSocket handshakes (no own listener). */
    private readonly socketServer = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_SOCKET_FRAME_BYTES,
    });
    /** Open plugin sockets with the registration they were accepted for. */
    private readonly openSockets = new Map<WebSocket, RegisteredWebSocket>();

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
        const authDeps: WebAuthDeps = {
            settings: auth,
            proxies: this.deps.trustedProxies,
            sessions: this.deps.sessions,
            log: this.deps.log,
        };
        this.authDeps = authDeps;
        this.app = this.buildApp(authDeps);
        const server = createAdaptorServer({
            // `createAdaptorServer` without `createServer` builds an
            // HTTP/1 server, so the bindings are always node's `HttpBindings`.
            fetch: (request: Request, env: HttpBindings | Http2Bindings) => {
                const app = this.app;
                return app === null
                    ? new Response("Service Unavailable", { status: 503 })
                    : app.fetch(request, env as WebEnv["Bindings"]);
            },
        }) as Server;
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
        server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
            void this.handleUpgrade(req, socket, head);
        });
        this.server = server;
        const unsubscribeUis = this.deps.webUis.onChange(() => this.rebuildApp());
        const unsubscribePlugins = this.deps.webPlugins.onChange(() => this.rebuildApp());
        this.unsubscribeRegistries = () => {
            unsubscribeUis();
            unsubscribePlugins();
        };
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
        this.unsubscribeRegistries?.();
        this.unsubscribeRegistries = null;
        this.app = null;
        this.authDeps = null;
        for (const ws of this.openSockets.keys()) {
            ws.terminate();
        }
        this.openSockets.clear();
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
     * Rebuild the app after the web UI controllers changed. No-op while
     * stopped; the next {@link start} builds a fresh app anyway.
     */
    private rebuildApp(): void {
        if (this.server === null || this.authDeps === null) {
            return;
        }
        this.app = this.buildApp(this.authDeps);
        this.closeStaleSockets();
        this.deps.log.info(`webserver: web UI changed — ${describeSelection(this.selectWebUi())}`);
    }

    /**
     * Close the open sockets whose plugin re-registered or unregistered
     * (plugin restart): the new registration has fresh handlers, the old
     * connections belong to the stopped instance.
     */
    private closeStaleSockets(): void {
        for (const [ws, endpoint] of this.openSockets) {
            if (this.deps.webPlugins.get(endpoint.pluginId) !== endpoint.ui) {
                this.openSockets.delete(ws);
                ws.close(1012, "plugin restarted");
            }
        }
    }

    /**
     * Serve a WebSocket handshake: find the plugin endpoint, authenticate,
     * then hand the accepted socket to the plugin. Every failure answers
     * with a plain HTTP status on the raw socket.
     *
     * @param req The upgrade request.
     * @param socket The raw TCP socket.
     * @param head First packet of the upgraded stream.
     */
    private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        socket.on("error", (err) => {
            this.deps.log.warn(
                `webserver: WebSocket ${req.url ?? "?"} socket error: ${err.message}`,
            );
        });
        const authDeps = this.authDeps;
        if (authDeps === null) {
            rejectUpgrade(socket, 503, "webserver is stopping");
            return;
        }
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const endpoint = this.deps.webPlugins.findSocket(pathname);
        if (endpoint === undefined) {
            rejectUpgrade(socket, 404, "no WebSocket endpoint at this path");
            return;
        }
        let auth: Awaited<ReturnType<typeof authenticateUpgrade>>;
        try {
            auth = await authenticateUpgrade(req, authDeps);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.deps.log.error(
                `webserver: WebSocket ${pathname} authentication failed: ${message}`,
            );
            rejectUpgrade(socket, 500, "authentication failed");
            return;
        }
        if (auth.kind === "rejected") {
            this.deps.log.warn(
                `webserver: rejected WebSocket ${pathname} with ${auth.status} — ${auth.reason}`,
            );
            rejectUpgrade(socket, auth.status, auth.reason);
            return;
        }
        // The plugin may have restarted, or the server stopped, while we awaited.
        if (this.server === null || this.deps.webPlugins.get(endpoint.pluginId) !== endpoint.ui) {
            rejectUpgrade(socket, 503, "plugin restarting");
            return;
        }
        this.socketServer.handleUpgrade(req, socket, head, (ws) => {
            this.openSockets.set(ws, endpoint);
            ws.on("close", () => this.openSockets.delete(ws));
            ws.on("error", (err) => {
                this.deps.log.warn(`webserver: WebSocket ${pathname} error: ${err.message}`);
            });
            const reportHandlerError = (err: unknown): void => {
                const message = err instanceof Error ? err.message : String(err);
                this.deps.log.error(
                    `webserver: plugin "${endpoint.pluginId}" WebSocket ${pathname} handler threw: ${message}`,
                );
                ws.close(1011, "internal error");
            };
            const peer = new WsPeer(ws, reportHandlerError);
            try {
                endpoint.socket.onConnection(peer, {
                    principal: auth.principal,
                    isHttps: auth.isHttps,
                });
            } catch (err) {
                reportHandlerError(err);
            }
        });
    }

    /**
     * Pick the web UI controller per `webserver.uiPlugin` (read per build).
     *
     * @returns The registry's selection.
     */
    private selectWebUi(): WebUiSelection {
        const preferred = this.deps.config.getString("webserver.uiPlugin", "").trim();
        return this.deps.webUis.select(preferred === "" ? undefined : preferred);
    }

    /**
     * Build the Hono application served by this server: the auth
     * middleware in front of everything, the login routes (rendered by
     * the selected web UI when it can), then its root controller (or the
     * plain fallback page).
     *
     * @param auth Auth settings and stores for this start.
     * @returns A fresh Hono app.
     */
    private buildApp(auth: WebAuthDeps): Hono<WebEnv> {
        const app = new Hono<WebEnv>();
        app.use(createAuthMiddleware(auth));
        const selection = this.selectWebUi();
        const ui = selection.kind === "selected" ? selection.ui : undefined;
        mountLoginRoutes(app, auth, ui?.renderAuthPage);
        // Plugin controllers before the UI root: they register concrete
        // routes only, so their page routes fall through to the web UI.
        for (const { pluginId, ui: plugin } of this.deps.webPlugins.listControllers()) {
            app.route(webPluginBasePath(pluginId), plugin.controller as unknown as Hono<WebEnv>);
        }
        if (ui !== undefined) {
            app.route("/", ui.controller as unknown as Hono<WebEnv>);
        } else {
            mountNoWebUiFallback(app, selection);
        }
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
 * Serve the plain page shown when no web UI controller is selected: who
 * is signed in, a sign-out button, and what to install or configure.
 * Non-GET requests get 404.
 *
 * @param app The webserver app.
 * @param selection Why no controller was selected.
 */
function mountNoWebUiFallback(app: Hono<WebEnv>, selection: WebUiSelection): void {
    app.get("*", (c) => {
        const principal = c.get("principal");
        return c.html(
            page(
                "No web UI installed",
                html`<p>Signed in as ${principal.displayName} (${principal.login}, via ${principal.via}).</p>
                    <p>${describeSelection(selection)}</p>
                    <form method="post" action="/logout"><button type="submit">Sign out</button></form>`,
            ),
        );
    });
}

/**
 * Explain a web UI selection for the fallback page and the log.
 *
 * @param selection The registry's selection.
 * @returns One human-readable sentence.
 */
function describeSelection(selection: WebUiSelection): string {
    switch (selection.kind) {
        case "selected":
            return `serving the web UI of plugin "${selection.pluginId}"`;
        case "none":
            return "No plugin provides a web UI. Install a web UI plugin such as @getfamiliar/plugin-web-ui (id web-ui) and restart the daemon.";
        case "notProvided":
            return `webserver.uiPlugin names "${selection.preferredId}", but that plugin provides no web UI (loaded, healthy providers: ${selection.available.length === 0 ? "none" : selection.available.join(", ")}). Fix webserver.uiPlugin and run familiar config reload.`;
        case "ambiguous":
            return `Several plugins provide a web UI (${selection.available.join(", ")}). Pick one with webserver.uiPlugin and run familiar config reload.`;
    }
}

/**
 * Refuse a WebSocket handshake with a plain HTTP response and drop the socket.
 *
 * @param socket The raw socket of the upgrade request.
 * @param status HTTP status.
 * @param reason Body text.
 */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    const body = `${STATUS_CODES[status] ?? "Error"}: ${reason}`;
    socket.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
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
