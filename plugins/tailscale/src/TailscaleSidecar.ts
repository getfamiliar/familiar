import { mkdirSync } from "node:fs";
import path from "node:path";
import {
    dockerCapture,
    dockerExec,
    hostGatewayArgs,
    isContainerRunning,
    isImagePresent,
    removeContainer,
    SHARED_NETWORK_NAME,
    stopContainer,
} from "@getfamiliar/shared";

/** Name of the sidecar container. */
export const TAILSCALE_CONTAINER_NAME = "familiar-tailscale";

/**
 * Pinned Tailscale image. Bump deliberately: look up the digest with
 * `docker buildx imagetools inspect tailscale/tailscale:<tag>`.
 */
export const TAILSCALE_IMAGE =
    "tailscale/tailscale:v1.104.4@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c";

/** tailscaled's local API socket inside the container (writable as non-root). */
const CONTAINER_SOCKET = "/tmp/tailscaled.sock";

/** Mount point of the persisted node state inside the container. */
const CONTAINER_STATE_DIR = "/var/lib/tailscale";

/**
 * Upper bound for `tailscale serve`. It blocks waiting for an admin
 * confirmation when HTTPS certificates are not enabled in the tailnet;
 * the busybox `timeout` in the image cuts that off.
 */
const SERVE_TIMEOUT_SECONDS = 20;

/** Exit code of busybox `timeout` when it had to kill the command. */
const TIMEOUT_EXIT_CODE = 143;

/** Inputs for {@link buildRunArgs}. */
export interface SidecarRunOptions {
    /** Host directory holding the node state (`<dataDir>/tailscale/state`). */
    readonly stateDir: string;
    /** Host uid/gid the container runs as, so state files stay operator-owned. */
    readonly uid: number;
    readonly gid: number;
}

/** Inputs for {@link buildUpArgs}. */
export interface LoginOptions {
    /** Device name in the tailnet. */
    readonly hostname: string;
    /** Optional auth key for an unattended login. */
    readonly authKey: string | null;
}

/** Login state of the sidecar node, read from `tailscale status --json`. */
export interface TailscaleStatus {
    /** tailscaled backend state (`NeedsLogin`, `Starting`, `Running`, `Stopped`, …). */
    readonly backendState: string;
    /** Interactive login URL while a login is pending, else null. */
    readonly authUrl: string | null;
    /** MagicDNS name of the node without the trailing dot, once known. */
    readonly dnsName: string | null;
}

/**
 * Build the `docker run` arguments of the sidecar. The entrypoint is
 * `tailscaled` itself — not the image's `containerboot`, whose boot
 * phase gives up on an interactive login after 60 s. tailscaled runs in
 * userspace networking mode (no TUN device, no SOCKS / HTTP proxy), so
 * the node cannot route anywhere; what it serves is set by
 * {@link applyServe}.
 *
 * @param options Sidecar settings.
 * @returns Arguments after `docker`.
 */
export function buildRunArgs(options: SidecarRunOptions): string[] {
    return [
        "run",
        "-d",
        "--name",
        TAILSCALE_CONTAINER_NAME,
        "--network",
        SHARED_NETWORK_NAME,
        ...hostGatewayArgs(),
        "--user",
        `${options.uid}:${options.gid}`,
        "-v",
        `${options.stateDir}:${CONTAINER_STATE_DIR}`,
        "--entrypoint",
        "tailscaled",
        TAILSCALE_IMAGE,
        "--tun=userspace-networking",
        `--statedir=${CONTAINER_STATE_DIR}`,
        `--socket=${CONTAINER_SOCKET}`,
    ];
}

/**
 * Build the `tailscale up` arguments. `--reset` makes the flags the
 * complete preference set: no routes or DNS accepted, nothing
 * advertised, no Tailscale SSH. No `--timeout`, so a pending
 * interactive login waits as long as the user needs.
 *
 * @param options Hostname and optional auth key.
 * @returns Arguments after `tailscale`.
 */
export function buildUpArgs(options: LoginOptions): string[] {
    const args = [
        "up",
        "--reset",
        `--hostname=${options.hostname}`,
        "--accept-dns=false",
        "--accept-routes=false",
    ];
    if (options.authKey !== null) {
        args.push(`--auth-key=${options.authKey}`);
    }
    return args;
}

/**
 * Build the `tailscale serve` arguments: HTTPS on :443 only, proxied to
 * the familiar webserver on the host. There is deliberately no HTTP /
 * :80 listener.
 *
 * @param webServerPort Port the host webserver listens on.
 * @returns Arguments after `tailscale`.
 */
export function buildServeArgs(webServerPort: number): string[] {
    return [
        "serve",
        "--bg",
        "--yes",
        "--https=443",
        `http://host.docker.internal:${webServerPort}`,
    ];
}

/**
 * Parse `tailscale status --json` output.
 *
 * @param json Raw stdout of the status command.
 * @returns The login-relevant fields.
 * @throws {SyntaxError} When the output is not JSON.
 */
export function parseStatus(json: string): TailscaleStatus {
    const parsed = JSON.parse(json) as {
        BackendState?: unknown;
        AuthURL?: unknown;
        Self?: { DNSName?: unknown };
    };
    const authUrl =
        typeof parsed.AuthURL === "string" && parsed.AuthURL !== "" ? parsed.AuthURL : null;
    const rawDnsName = parsed.Self?.DNSName;
    const dnsName =
        typeof rawDnsName === "string" && rawDnsName !== "" ? rawDnsName.replace(/\.$/, "") : null;
    return {
        backendState: typeof parsed.BackendState === "string" ? parsed.BackendState : "Unknown",
        authUrl,
        dnsName,
    };
}

/**
 * (Re)create and start the sidecar: pull the pinned image if missing,
 * remove a stale container, run a fresh one.
 *
 * @param pluginDataDir `<dataDir>/tailscale`; its `state/` is created when missing.
 * @param options uid/gid to run as.
 * @throws {Error} When a docker command fails.
 */
export async function startSidecar(
    pluginDataDir: string,
    options: Omit<SidecarRunOptions, "stateDir">,
): Promise<void> {
    const stateDir = path.join(pluginDataDir, "state");
    mkdirSync(stateDir, { recursive: true });
    if (!(await isImagePresent(TAILSCALE_IMAGE))) {
        await dockerExec(["pull", TAILSCALE_IMAGE]);
    }
    await removeContainer(TAILSCALE_CONTAINER_NAME);
    await dockerExec(buildRunArgs({ ...options, stateDir }));
}

/** Stop and remove the sidecar; tolerates a missing container. */
export async function stopSidecar(): Promise<void> {
    await stopContainer(TAILSCALE_CONTAINER_NAME);
    await removeContainer(TAILSCALE_CONTAINER_NAME);
}

/**
 * Whether the sidecar container is up.
 *
 * @returns True when `familiar-tailscale` is running.
 */
export function isSidecarRunning(): Promise<boolean> {
    return isContainerRunning(TAILSCALE_CONTAINER_NAME);
}

/**
 * Read the node's login state via the tailscale CLI inside the sidecar.
 *
 * @returns The parsed status.
 * @throws {Error} When the command fails (container down, tailscaled not up yet).
 */
export async function readStatus(): Promise<TailscaleStatus> {
    return parseStatus(await runTailscaleCli(["status", "--json"]));
}

/**
 * Apply the login preferences and start a login if needed. Runs
 * `tailscale up` detached inside the container: with a pending
 * interactive login it keeps waiting there, and the login URL shows up
 * in {@link readStatus}. Already logged in, it only applies the prefs.
 *
 * @param options Hostname and optional auth key.
 * @throws {Error} When the exec cannot be started; the auth key is masked.
 */
export async function requestLogin(options: LoginOptions): Promise<void> {
    try {
        await dockerExec([
            "exec",
            "-d",
            TAILSCALE_CONTAINER_NAME,
            "tailscale",
            `--socket=${CONTAINER_SOCKET}`,
            ...buildUpArgs(options),
        ]);
    } catch (err) {
        // dockerExec echoes the full argv, which includes the auth key.
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
            options.authKey === null ? message : message.replaceAll(options.authKey, "***"),
        );
    }
}

/**
 * Replace the node's serve config with HTTPS :443 → the webserver.
 * Needs a logged-in node (the certificate domain must be known).
 *
 * @param webServerPort Port the host webserver listens on.
 * @throws {Error} When serve fails or times out (HTTPS certificates not
 *   enabled in the tailnet is the usual cause).
 */
export async function applyServe(webServerPort: number): Promise<void> {
    await runTailscaleCli(["serve", "reset"]);
    try {
        await runTailscaleCli(buildServeArgs(webServerPort), SERVE_TIMEOUT_SECONDS);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
            `${message} — make sure MagicDNS and HTTPS certificates are enabled in the tailnet admin console`,
        );
    }
}

/**
 * Log the node out of the tailnet. tailscaled keeps running and waits
 * for the next `tailscale up`.
 *
 * @throws {Error} When the logout fails.
 */
export async function logoutSidecar(): Promise<void> {
    await runTailscaleCli(["logout"]);
}

/**
 * Run the tailscale CLI inside the sidecar against its socket.
 *
 * @param args CLI arguments after `tailscale`.
 * @param timeoutSeconds Optional limit enforced by busybox `timeout`.
 * @returns stdout.
 * @throws {Error} When the command exits non-zero or times out.
 */
async function runTailscaleCli(args: readonly string[], timeoutSeconds?: number): Promise<string> {
    const prefix = timeoutSeconds === undefined ? [] : ["timeout", String(timeoutSeconds)];
    const result = await dockerCapture([
        "exec",
        TAILSCALE_CONTAINER_NAME,
        ...prefix,
        "tailscale",
        `--socket=${CONTAINER_SOCKET}`,
        ...args,
    ]);
    if (result.code === TIMEOUT_EXIT_CODE && timeoutSeconds !== undefined) {
        throw new Error(
            `tailscale ${args.join(" ")} in container ${TAILSCALE_CONTAINER_NAME} did not finish within ${timeoutSeconds}s`,
        );
    }
    if (result.code !== 0) {
        throw new Error(
            `tailscale ${args.join(" ")} in container ${TAILSCALE_CONTAINER_NAME} failed (exit ${result.code})`,
        );
    }
    return result.stdout;
}
