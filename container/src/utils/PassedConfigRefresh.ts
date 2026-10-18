import type { Logger } from "@getfamiliar/shared";
import { bastionAuthHeaders } from "./BastionAuth.js";
import { applyPassedConfigOverlay } from "./PassedConfig.js";

/**
 * Fetch the host's current passed config (`GET /container-config/`) and
 * apply it as the {@link applyPassedConfigOverlay overlay}, so settings
 * changed by a host config reload apply to the next agentrun without a
 * container restart. Called once per fresh agentrun; a failed fetch is
 * logged and the previous values stay in effect.
 *
 * @param bastionUrl Bastion base URL.
 * @param bastionToken Shared bastion token.
 * @param log Logger for the failure / change lines.
 */
export async function refreshPassedConfig(
    bastionUrl: string,
    bastionToken: string,
    log: Logger,
): Promise<void> {
    const url = `${bastionUrl.replace(/\/$/, "")}/container-config/`;
    try {
        const res = await fetch(url, { headers: bastionAuthHeaders(bastionToken) });
        if (!res.ok) {
            throw new Error(`${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as { version?: unknown; values?: unknown };
        if (
            typeof body.version !== "number" ||
            body.values === null ||
            typeof body.values !== "object" ||
            Array.isArray(body.values)
        ) {
            throw new Error("malformed response body");
        }
        if (applyPassedConfigOverlay(body.version, body.values as Record<string, unknown>)) {
            log.info(`passed config updated to version ${body.version} (host config reload)`);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`passed config refresh via ${url} failed, keeping current values: ${message}`);
    }
}
