import type { Bootstrap } from "../Bootstrap.js";
import { readBastionTokenFile } from "../bastion/BastionToken.js";
import {
    DAEMON_BASTION_LOOPBACK_URL,
    daemonBastionHeaders,
    isDaemonRunning,
} from "../commands/tools/render.js";
import type { ReloadReport } from "./DaemonReloader.js";
import { RELOAD_PREFIX } from "./ReloadGateway.js";

/**
 * Ask the running daemon to reload `config.yml` and `mcp.yml` through
 * its bastion (`POST /config-reload/`), authenticating with the token
 * the daemon left in `tmp/.bastion-token`.
 *
 * @param boot Bootstrap paths (pidfile, token file).
 * @returns The daemon's report, or `null` when no daemon is running.
 * @throws If the daemon is running but the request fails.
 */
export async function requestDaemonReload(boot: Bootstrap): Promise<ReloadReport | null> {
    if (!isDaemonRunning(boot.pidFile)) {
        return null;
    }
    const url = `${DAEMON_BASTION_LOOPBACK_URL}${RELOAD_PREFIX}`;
    const res = await fetch(url, {
        method: "POST",
        headers: daemonBastionHeaders(readBastionTokenFile(boot)),
    });
    if (!res.ok) {
        throw new Error(`config reload via ${url} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as ReloadReport;
}
