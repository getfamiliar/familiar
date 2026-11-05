import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
    dockerExec,
    isImagePresent,
    PROXY_SECRET_HEADER,
    removeContainer,
    stopContainer,
} from "@getfamiliar/shared";
import { TAILSCALE_CONTAINER_NAME } from "./TailscaleSidecar.js";

/** Name of the header-injecting proxy container. */
export const PROXY_CONTAINER_NAME = "familiar-tailscale-proxy";

/**
 * Pinned Caddy image. Bump deliberately: look up the digest with
 * `docker buildx imagetools inspect caddy:<tag>`.
 */
export const CADDY_IMAGE =
    "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";

/**
 * Port Caddy listens on, on 127.0.0.1 of the sidecar's network namespace.
 * `tailscale serve` proxies to it; nothing outside that namespace can.
 */
export const PROXY_LISTEN_PORT = 18080;

/** Mount point of the generated Caddyfile inside the proxy container. */
const CONTAINER_CADDYFILE = "/etc/caddy/Caddyfile";

/** File names under `<dataDir>/tailscale/`. */
const SECRET_FILE = "proxy-secret";
const CADDYFILE = "Caddyfile";

/** Inputs for {@link buildProxyRunArgs}. */
export interface ProxyRunOptions {
    /** Host path of the generated Caddyfile. */
    readonly caddyfilePath: string;
    /** Host uid/gid the container runs as (so it can read the 0600 Caddyfile). */
    readonly uid: number;
    readonly gid: number;
}

/**
 * Read the plugin's trusted-proxy secret, creating it on first use. The
 * file is mode 0600 and survives restarts, so the registration and the
 * Caddyfile always agree.
 *
 * @param pluginDataDir `<dataDir>/tailscale`.
 * @returns The secret.
 */
export function readOrCreateProxySecret(pluginDataDir: string): string {
    const file = path.join(pluginDataDir, SECRET_FILE);
    if (existsSync(file)) {
        const existing = readFileSync(file, "utf-8").trim();
        if (existing !== "") {
            return existing;
        }
    }
    mkdirSync(pluginDataDir, { recursive: true });
    const secret = randomBytes(32).toString("base64url");
    writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return secret;
}

/**
 * Build the Caddyfile: listen on 127.0.0.1 only, forward to the host
 * webserver and set the trusted-proxy secret header (replacing any value
 * a client sent). `trusted_proxies` keeps the `X-Forwarded-*` headers
 * `tailscale serve` set, so the webserver sees the browser's HTTPS
 * scheme and tailnet host. Admin API, automatic HTTPS and config
 * persistence are off.
 *
 * @param secret Trusted-proxy secret.
 * @param webServerPort Port of the host webserver.
 * @returns Caddyfile text.
 */
export function buildCaddyfile(secret: string, webServerPort: number): string {
    return [
        "{",
        "\tadmin off",
        "\tauto_https off",
        "\tpersist_config off",
        "\tservers {",
        "\t\ttrusted_proxies static 127.0.0.1/32 ::1/128",
        "\t}",
        "}",
        "",
        `:${PROXY_LISTEN_PORT} {`,
        "\tbind 127.0.0.1",
        `\treverse_proxy host.docker.internal:${webServerPort} {`,
        `\t\theader_up ${PROXY_SECRET_HEADER} "${secret}"`,
        "\t}",
        "}",
        "",
    ].join("\n");
}

/**
 * Build the `docker run` arguments of the proxy. It joins the network
 * namespace of the tailscale sidecar (`--network container:`), which
 * also gives it the sidecar's `/etc/hosts` with `host.docker.internal`.
 * Without its own interface on `familiar-net`, the agent and MCP
 * containers cannot reach it and forge identity headers.
 *
 * @param options Caddyfile path and uid/gid.
 * @returns Arguments after `docker`.
 */
export function buildProxyRunArgs(options: ProxyRunOptions): string[] {
    return [
        "run",
        "-d",
        "--name",
        PROXY_CONTAINER_NAME,
        "--network",
        `container:${TAILSCALE_CONTAINER_NAME}`,
        "--user",
        `${options.uid}:${options.gid}`,
        "-v",
        `${options.caddyfilePath}:${CONTAINER_CADDYFILE}:ro`,
        CADDY_IMAGE,
        "caddy",
        "run",
        "--config",
        CONTAINER_CADDYFILE,
        "--adapter",
        "caddyfile",
    ];
}

/**
 * (Re)create and start the proxy after the sidecar is up: write the
 * Caddyfile (0600), pull the pinned image if missing, replace a stale
 * container.
 *
 * @param pluginDataDir `<dataDir>/tailscale`.
 * @param secret Trusted-proxy secret.
 * @param webServerPort Port of the host webserver.
 * @param ids uid/gid to run as.
 * @throws {Error} When a docker command fails.
 */
export async function startProxy(
    pluginDataDir: string,
    secret: string,
    webServerPort: number,
    ids: { readonly uid: number; readonly gid: number },
): Promise<void> {
    mkdirSync(pluginDataDir, { recursive: true });
    const caddyfilePath = path.join(pluginDataDir, CADDYFILE);
    writeFileSync(caddyfilePath, buildCaddyfile(secret, webServerPort), { mode: 0o600 });
    chmodSync(caddyfilePath, 0o600);
    if (!(await isImagePresent(CADDY_IMAGE))) {
        await dockerExec(["pull", CADDY_IMAGE]);
    }
    await removeContainer(PROXY_CONTAINER_NAME);
    await dockerExec(buildProxyRunArgs({ caddyfilePath, ...ids }));
}

/** Stop and remove the proxy; tolerates a missing container. */
export async function stopProxy(): Promise<void> {
    await stopContainer(PROXY_CONTAINER_NAME);
    await removeContainer(PROXY_CONTAINER_NAME);
}
