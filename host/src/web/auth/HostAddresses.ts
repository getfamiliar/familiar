import { readFileSync } from "node:fs";
import os from "node:os";

/** A base URL under which this machine might serve the web UI on the LAN. */
export interface DetectedBaseUrl {
    readonly url: string;
    /** Where it came from: `hostname` or the interface name (`eth0`, …). */
    readonly source: string;
}

/** Result of {@link detectLanBaseUrls}. */
export interface LanDetection {
    readonly urls: readonly DetectedBaseUrl[];
    /** Caveats about reachability, for the agent and the CLI. */
    readonly notes: readonly string[];
}

/** Interfaces that never face the LAN: docker / VM bridges, VPN tunnels. */
const NON_LAN_INTERFACE = /^(docker|br-|veth|virbr|vmnet|cni|flannel|cali|tailscale|tun|tap|wg|zt)/;

/** Bind addresses that make the webserver local-only. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Bind addresses meaning "all interfaces". */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", ""]);

/**
 * Guess base URLs under which other devices on the LAN could reach the
 * webserver: the machine's host name and its non-internal IPv4 addresses
 * (docker bridges and VPN tunnels skipped). These are candidates only:
 * whether a router, a firewall or WSL2's NAT lets them through cannot be
 * seen from here.
 *
 * @param port Webserver port.
 * @param bindHost `webserver.host`.
 * @returns Candidate URLs plus caveats.
 */
export function detectLanBaseUrls(port: number, bindHost: string): LanDetection {
    const notes: string[] = [];
    if (LOOPBACK_HOSTS.has(bindHost)) {
        return {
            urls: [],
            notes: [
                `webserver.host is ${bindHost}, so the web UI is only reachable on this machine itself.`,
            ],
        };
    }
    const urls: DetectedBaseUrl[] = [];
    const hostname = os.hostname().trim();
    if (WILDCARD_HOSTS.has(bindHost)) {
        if (hostname !== "" && hostname !== "localhost") {
            urls.push({ url: `http://${hostname}:${port}`, source: "hostname" });
        }
        for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
            if (NON_LAN_INTERFACE.test(name)) {
                continue;
            }
            for (const address of addresses ?? []) {
                if (address.family === "IPv4" && !address.internal) {
                    urls.push({ url: `http://${address.address}:${port}`, source: name });
                }
            }
        }
    } else {
        urls.push({ url: `http://${bindHost}:${port}`, source: "webserver.host" });
    }
    if (isWsl()) {
        notes.push(
            "familiar runs in WSL2: in the default NAT mode its addresses are reachable only from the Windows host, not from other devices. LAN access needs WSL networkingMode=mirrored, or a Windows port forwarding (netsh interface portproxy) plus a firewall rule.",
        );
    }
    notes.push(
        "Detected LAN addresses are guesses; a firewall or router may block them. Prefer webserver.lanUrls once the user confirmed a working address.",
    );
    return { urls, notes };
}

/**
 * Whether this process runs inside WSL.
 *
 * @returns True under WSL1/WSL2.
 */
function isWsl(): boolean {
    if (process.env.WSL_DISTRO_NAME !== undefined) {
        return true;
    }
    try {
        return /microsoft/i.test(readFileSync("/proc/version", "utf-8"));
    } catch {
        // Not Linux, or /proc unavailable: not WSL.
        return false;
    }
}
