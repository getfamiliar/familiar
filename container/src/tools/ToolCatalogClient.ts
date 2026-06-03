import type { ContainerToolInfo, Logger } from "@getfamiliar/shared";

/**
 * POST the container's built-in tool catalog to the host bastion's
 * `/container-tools/` endpoint. The host stores the latest report in an
 * in-memory registry that backs the `tools list` CLI and the `tool_list`
 * reflection tool.
 *
 * Best-effort: a failed report only means the host's built-in listing is
 * stale until the next container start, so a transport error is logged
 * and swallowed rather than crashing the container. The URL construction
 * mirrors {@link import("../plugins/ToolsClient.js").PluginToolsClient}
 * (strip a trailing slash, append the prefix with its own trailing slash).
 *
 * @param bastionUrl Base URL of the host bastion (from `BASTION_URL`).
 * @param catalog The built-in tool catalog from `ToolsFactory.catalog()`.
 * @param log Logger child for the report line.
 */
export async function reportContainerToolCatalog(
    bastionUrl: string,
    catalog: readonly ContainerToolInfo[],
    log: Logger,
): Promise<void> {
    const url = `${bastionUrl.replace(/\/$/, "")}/container-tools/`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(catalog),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            log.warn(
                `container-tools report to ${url} failed: HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`,
            );
            return;
        }
        log.info(`reported ${catalog.length} container built-in tools to ${url}`);
    } catch (err) {
        log.warn(
            `container-tools report to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}
