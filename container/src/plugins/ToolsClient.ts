import { jsonSchema, type ToolSet, tool } from "ai";
import type { Logger } from "@getfamiliar/shared";

/**
 * Configuration for {@link PluginToolsClient}. Mirrors the
 * {@link import("../mcp/McpClientPool").McpClientPool} surface — the
 * agent dials the bastion through `BASTION_URL` and the client logs
 * lifecycle and per-call errors to a daemon-supplied logger.
 */
export interface PluginToolsClientConfig {
    /**
     * Bastion base URL. The client GETs `${bastionUrl}/plugin-tools/`
     * for the catalog and POSTs invocations to
     * `${bastionUrl}/plugin-tools/<key>`.
     */
    readonly bastionUrl: string;
    /** Logger child for fetch / dispatch lines. */
    readonly log: Logger;
}

/**
 * One catalog entry as the host gateway exposes it on
 * `GET /plugin-tools/`. Mirrors the registered-tool shape the host
 * registry stores; the client trusts the host's own lint and only
 * needs the three fields to build an AI SDK `tool()`.
 */
interface CatalogEntry {
    readonly key: string;
    readonly description: string;
    readonly inputSchema: object;
}

/**
 * Container-side discoverer for plugin-contributed tools. Unlike
 * {@link import("../mcp/McpClientPool").McpClientPool}, this client
 * is **fully lazy**: the catalog is fetched per-agentrun (see
 * {@link tools}) and every call closes over the originating event +
 * agentrun ids so the host gateway can resolve the full rows for
 * the plugin's `execute()`.
 *
 * Per-agentrun fetch trades a single sub-millisecond loopback HTTP
 * request for boot-order independence: the container can start
 * before plugins finish their `start(ctx)` hooks (which is the
 * current daemon order — see `host/src/commands/Start.ts`) and
 * still see tools the moment the first real agentrun fires. No
 * cache, no TTL, no invalidation knob to forget.
 *
 * Tool key namespacing matches MCP: the host already publishes
 * `${pluginId}_${name}` after sanitization, so the client passes
 * keys through verbatim and the agent's `tools:` DSL evaluator
 * treats each plugin id as a group via the supplied
 * {@link pluginKeysById} map.
 */
export class PluginToolsClient {
    private readonly config: PluginToolsClientConfig;

    constructor(config: PluginToolsClientConfig) {
        this.config = config;
    }

    /**
     * Fetch the live catalog and return a tool set whose `execute`
     * callbacks POST back to the gateway with `eventId` and
     * `agentrunId` already bound. Empty catalog → empty set.
     *
     * The second return value maps plugin id → set of that plugin's
     * sanitized tool keys, threaded into {@link
     * import("../tools/ToolsFactory").ToolsFactory}'s `builtins` so a
     * handler's `tools:` expression can reference a plugin id as a
     * group (`tools: system + mail`).
     */
    async tools(
        eventId: string,
        agentrunId: string,
    ): Promise<{ tools: ToolSet; keysById: ReadonlyMap<string, ReadonlySet<string>> }> {
        const catalog = await this.fetchCatalog();
        const toolSet: ToolSet = {};
        const keysById = new Map<string, Set<string>>();
        for (const entry of catalog) {
            toolSet[entry.key] = tool({
                description: entry.description,
                inputSchema: jsonSchema(entry.inputSchema),
                execute: async (args: unknown) => this.invoke(entry.key, args, eventId, agentrunId),
            });
            const pluginId = pluginIdFromKey(entry.key);
            if (pluginId !== undefined) {
                let set = keysById.get(pluginId);
                if (set === undefined) {
                    set = new Set();
                    keysById.set(pluginId, set);
                }
                set.add(entry.key);
            }
        }
        const frozen = new Map<string, ReadonlySet<string>>();
        for (const [id, keys] of keysById) {
            frozen.set(id, keys);
        }
        return { tools: toolSet, keysById: frozen };
    }

    /**
     * GET the bastion's plugin-tools catalog. Trailing slash is
     * required for the bastion's prefix router (same convention as
     * `/mcp/`).
     */
    private async fetchCatalog(): Promise<CatalogEntry[]> {
        const url = `${this.config.bastionUrl.replace(/\/$/, "")}/plugin-tools/`;
        const res = await fetch(url, { method: "GET" });
        if (!res.ok) {
            throw new Error(`fetch ${url} → ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as unknown;
        if (!Array.isArray(body)) {
            throw new Error("bastion /plugin-tools/ returned non-array body");
        }
        const out: CatalogEntry[] = [];
        for (const item of body) {
            if (
                item !== null &&
                typeof item === "object" &&
                typeof (item as { key?: unknown }).key === "string" &&
                typeof (item as { description?: unknown }).description === "string" &&
                typeof (item as { inputSchema?: unknown }).inputSchema === "object" &&
                (item as { inputSchema?: unknown }).inputSchema !== null
            ) {
                const e = item as CatalogEntry;
                out.push({ key: e.key, description: e.description, inputSchema: e.inputSchema });
            }
        }
        return out;
    }

    /**
     * POST the call to the gateway. Errors are surfaced to the model
     * as plain strings — the AI SDK's tool loop treats a thrown
     * `execute` as a fatal agent-loop failure, which is not what we
     * want for transient backend issues. The gateway already wraps
     * tool-level failures in `{ ok: false, error }`; this method
     * unwraps to either the raw result or a thrown Error carrying
     * the gateway's error string.
     */
    private async invoke(
        key: string,
        args: unknown,
        eventId: string,
        agentrunId: string,
    ): Promise<unknown> {
        const url = `${this.config.bastionUrl.replace(/\/$/, "")}/plugin-tools/${encodeURIComponent(key)}`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ args, eventId, agentrunId }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(
                `plugin tool ${key} HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`,
            );
        }
        const body = (await res.json()) as { ok?: unknown; result?: unknown; error?: unknown };
        if (body.ok === true) {
            return body.result;
        }
        const error = typeof body.error === "string" ? body.error : "plugin tool returned ok=false";
        this.config.log.warn({ tool: key, error }, "plugin tool error");
        throw new Error(error);
    }
}

/**
 * Recover the plugin id from a tool key. The host registry guarantees
 * `${pluginId}_${sanitizedToolName}` with the plugin id matching
 * `IDENT_PATTERN` (lowercase alnum, leading letter) — so the segment
 * up to the first `_` is the plugin id. Returns `undefined` for
 * pathological keys that don't fit the shape; the caller skips them.
 */
function pluginIdFromKey(key: string): string | undefined {
    const underscoreIdx = key.indexOf("_");
    if (underscoreIdx <= 0) {
        return undefined;
    }
    return key.slice(0, underscoreIdx);
}
