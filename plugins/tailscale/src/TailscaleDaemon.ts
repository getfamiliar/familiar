import path from "node:path";
import {
    DEFAULT_WEBSERVER_HOST,
    DEFAULT_WEBSERVER_PORT,
    type HostContext,
} from "@getfamiliar/shared";
import {
    applyServe,
    type LoginOptions,
    readStatus,
    requestLogin,
    startSidecar,
    stopSidecar,
    type TailscaleStatus,
} from "./TailscaleSidecar.js";

/** Default device name of the node in the tailnet. */
export const DEFAULT_TAILSCALE_HOSTNAME = "familiar";

/** Bind addresses the sidecar can reach via `host.docker.internal`. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/** Poll interval while the node is starting or waiting for a login. */
const PENDING_POLL_INTERVAL_MS = 3_000;

/** Poll interval once the node is logged in and serving (detects logouts). */
const RUNNING_POLL_INTERVAL_MS = 60_000;

/** How long tailscaled may take to answer its local API after the container start. */
const STARTUP_DEADLINE_MS = 30_000;

/** Mutable state of the running monitor; null while the plugin is stopped. */
interface MonitorState {
    readonly ctx: HostContext;
    readonly login: LoginOptions;
    readonly webServerPort: number;
    readonly startedAt: number;
    timer: NodeJS.Timeout | null;
    hasRequestedLogin: boolean;
    isServing: boolean;
    lastLoggedAuthUrl: string | null;
    hasLoggedLoggedOut: boolean;
    hasLoggedStartupFailure: boolean;
}

let monitor: MonitorState | null = null;

/**
 * Plugin directory for host-only state (`<dataDir>/tailscale`).
 *
 * @param ctx Host context.
 * @returns Absolute directory path.
 */
export function tailscaleDataDir(ctx: HostContext): string {
    return path.join(ctx.dataDir, "tailscale");
}

/**
 * Read hostname and auth key from config.
 *
 * @param ctx Host context.
 * @returns The login options.
 */
export function readLoginOptions(ctx: HostContext): LoginOptions {
    return {
        hostname: ctx.config.getString("tailscale.hostname", DEFAULT_TAILSCALE_HOSTNAME),
        authKey: ctx.config.getString("tailscale.authKey", null),
    };
}

/**
 * Start the tailscale sidecar when the webserver is enabled, then run a
 * background monitor that requests the login, applies the serve config
 * once the node is logged in and logs the login / tailnet URLs.
 *
 * @param ctx Host context.
 * @throws {Error} When the sidecar container cannot be started.
 */
export async function startTailscaleDaemon(ctx: HostContext): Promise<void> {
    const log = ctx.logger;
    if (ctx.config.getBool("webserver.enabled", false) !== true) {
        log.warn(
            "tailscale: not starting — webserver.enabled is not true, so there is nothing to publish in the tailnet",
        );
        return;
    }
    const webServerHost = ctx.config.getString("webserver.host", DEFAULT_WEBSERVER_HOST);
    if (!WILDCARD_HOSTS.has(webServerHost)) {
        log.warn(
            `tailscale: webserver.host is "${webServerHost}"; the tailscale container reaches the webserver via host.docker.internal, which usually needs webserver.host 0.0.0.0`,
        );
    }
    const webServerPort = ctx.config.getNumber("webserver.port", DEFAULT_WEBSERVER_PORT);
    const login = readLoginOptions(ctx);
    await startSidecar(tailscaleDataDir(ctx), {
        uid: process.getuid?.() ?? 1000,
        gid: process.getgid?.() ?? 1000,
    });
    log.info(
        `tailscale: sidecar started as tailnet device "${login.hostname}", will serve HTTPS :443 → webserver port ${webServerPort}`,
    );
    monitor = {
        ctx,
        login,
        webServerPort,
        startedAt: Date.now(),
        timer: null,
        hasRequestedLogin: false,
        isServing: false,
        lastLoggedAuthUrl: null,
        hasLoggedLoggedOut: false,
        hasLoggedStartupFailure: false,
    };
    schedule(monitor, PENDING_POLL_INTERVAL_MS);
}

/** Stop the monitor and the sidecar container. */
export async function stopTailscaleDaemon(): Promise<void> {
    if (monitor === null) {
        return;
    }
    const state = monitor;
    monitor = null;
    if (state.timer !== null) {
        clearTimeout(state.timer);
    }
    await stopSidecar();
}

/**
 * Schedule the next monitor tick.
 *
 * @param state Monitor state.
 * @param delayMs Delay until the tick.
 */
function schedule(state: MonitorState, delayMs: number): void {
    state.timer = setTimeout(() => {
        state.timer = null;
        void tick(state).then((nextDelayMs) => {
            if (monitor === state) {
                schedule(state, nextDelayMs);
            }
        });
    }, delayMs);
}

/**
 * One monitor step. Never throws: failures are logged and retried.
 *
 * @param state Monitor state.
 * @returns Delay until the next tick.
 */
async function tick(state: MonitorState): Promise<number> {
    const log = state.ctx.logger;
    let status: TailscaleStatus;
    try {
        status = await readStatus();
    } catch (err) {
        reportStartupProblem(state, err);
        return PENDING_POLL_INTERVAL_MS;
    }
    try {
        if (!state.hasRequestedLogin) {
            // Always once per start: applies hostname / prefs even when the
            // persisted state is already logged in.
            state.hasRequestedLogin = true;
            await requestLogin(state.login);
            return PENDING_POLL_INTERVAL_MS;
        }
        if (status.backendState === "Running") {
            state.hasLoggedLoggedOut = false;
            if (!state.isServing) {
                await applyServe(state.webServerPort);
                state.isServing = true;
                log.info(
                    `tailscale: familiar web UI reachable in your tailnet at https://${status.dnsName ?? `${state.login.hostname}.<tailnet>.ts.net`}/`,
                );
            }
            return RUNNING_POLL_INTERVAL_MS;
        }
        state.isServing = false;
        if (status.backendState === "NeedsLogin") {
            if (status.authUrl !== null && status.authUrl !== state.lastLoggedAuthUrl) {
                state.lastLoggedAuthUrl = status.authUrl;
                log.warn(
                    `tailscale: not logged in — open ${status.authUrl} or run "familiar tailscale login"`,
                );
            } else if (status.authUrl === null && !state.hasLoggedLoggedOut) {
                state.hasLoggedLoggedOut = true;
                log.warn(
                    'tailscale: node is logged out of the tailnet — run "familiar tailscale login" to join again',
                );
            }
        }
    } catch (err) {
        log.error(`tailscale: ${err instanceof Error ? err.message : String(err)}`);
    }
    return PENDING_POLL_INTERVAL_MS;
}

/**
 * Log once when tailscaled has not answered within the startup deadline.
 *
 * @param state Monitor state.
 * @param err The last status error.
 */
function reportStartupProblem(state: MonitorState, err: unknown): void {
    if (state.hasLoggedStartupFailure || Date.now() - state.startedAt < STARTUP_DEADLINE_MS) {
        return;
    }
    state.hasLoggedStartupFailure = true;
    state.ctx.logger.warn(
        `tailscale: tailscaled is not answering (${err instanceof Error ? err.message : String(err)}); check "docker logs familiar-tailscale"`,
    );
}
