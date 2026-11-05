import path from "node:path";
import type { Logger, WebUiEnv } from "@getfamiliar/shared";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Context } from "hono";
import type { ViteDevServer, Logger as ViteLogger } from "vite";

/** Port of Vite's HMR websocket; it listens on loopback only. */
export const HMR_PORT = 24678;

/**
 * Vite dev server in middleware mode, embedded in the daemon for dev
 * mode (`FAMILIAR_DEV=1`): the UI sources are served on the fly and
 * edits reach the browser through hot module replacement, without a
 * daemon restart.
 *
 * Page and module requests come through the core webserver (behind its
 * authentication) and are handed to Vite's connect middleware via the
 * node bindings. Only the HMR websocket listens separately, on
 * `127.0.0.1:{@link HMR_PORT}`, so live reload works when the UI is
 * opened via localhost; through a proxy (tailnet) the page works but
 * does not reload by itself.
 */
export class ViteDevBridge {
    private readonly server: ViteDevServer;

    /**
     * @param server The running Vite dev server.
     */
    private constructor(server: ViteDevServer) {
        this.server = server;
    }

    /**
     * Start Vite in middleware mode with the plugin's `vite.config.ts`.
     *
     * @param pluginRoot Plugin package directory (Vite root).
     * @param log Plugin logger; Vite's output is forwarded to it.
     * @returns The bridge.
     * @throws {Error} When `vite` is not installed (dev dependency) or the
     *   server cannot be created.
     */
    static async start(pluginRoot: string, log: Logger): Promise<ViteDevBridge> {
        let vite: typeof import("vite");
        try {
            vite = await import("vite");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(
                `web-ui: dev mode needs the dev dependency "vite" (run npm install in the checkout): ${message}`,
            );
        }
        const server = await vite.createServer({
            root: pluginRoot,
            configFile: path.join(pluginRoot, "vite.config.ts"),
            appType: "spa",
            customLogger: forwardingLogger(log),
            server: {
                middlewareMode: true,
                // The core webserver authenticates every request before it
                // reaches Vite, under whatever host the browser used.
                allowedHosts: true,
                hmr: { host: "127.0.0.1", port: HMR_PORT },
            },
        });
        log.info(
            `web-ui: dev mode — serving sources from ${pluginRoot} with hot reload (HMR websocket on 127.0.0.1:${HMR_PORT})`,
        );
        return new ViteDevBridge(server);
    }

    /**
     * Hand one request to Vite's middleware stack.
     *
     * @param c Request context with the node bindings.
     * @returns `RESPONSE_ALREADY_SENT` when Vite answered, else 404.
     */
    async handle(c: Context<WebUiEnv>): Promise<Response> {
        const { incoming, outgoing } = c.env;
        const isHandled = await new Promise<boolean>((resolve, reject) => {
            outgoing.once("finish", () => resolve(true));
            this.server.middlewares(incoming, outgoing, (err?: unknown) => {
                if (err !== undefined && err !== null) {
                    reject(err instanceof Error ? err : new Error(String(err)));
                    return;
                }
                resolve(false);
            });
        });
        return isHandled ? RESPONSE_ALREADY_SENT : c.notFound();
    }

    /** Shut the Vite server (watchers, HMR websocket) down. */
    async close(): Promise<void> {
        await this.server.close();
    }
}

/**
 * A Vite logger that writes into the plugin's log instead of the console.
 *
 * @param log Plugin logger.
 * @returns The Vite logger.
 */
function forwardingLogger(log: Logger): ViteLogger {
    const warned = new Set<string>();
    let hasErrorLogged = false;
    return {
        hasWarned: false,
        info: (msg) => log.debug(`vite: ${msg}`),
        warn(msg) {
            this.hasWarned = true;
            log.warn(`vite: ${msg}`);
        },
        warnOnce(msg) {
            if (warned.has(msg)) {
                return;
            }
            warned.add(msg);
            this.warn(msg);
        },
        error: (msg) => {
            hasErrorLogged = true;
            log.error(`vite: ${msg}`);
        },
        clearScreen: () => {},
        hasErrorLogged: () => hasErrorLogged,
    };
}
