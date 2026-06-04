import { CORE_PLUGIN_ID, type Logger, ToolError } from "@getfamiliar/shared";
import { jsonSchema, type ToolSet, tool } from "ai";

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
    /**
     * Plugin id this tool belongs to, or the reserved sentinel
     * {@link CORE_PLUGIN_ID} (`"core"`) for host-owned tools
     * registered without a plugin-id prefix (e.g. the `cal_*`
     * calendar tools). For a real plugin id this buckets the key into
     * a per-plugin auto-group so a handler's `tools: <pluginId>`
     * resolves to every key the plugin contributes. The `core`
     * sentinel is **not** turned into an auto-group: it would collide
     * with — and shadow — the curated `core` group. Host-owned tools
     * reach addressable groups via their {@link groups} field
     * (`["cal"]`, `["mail"]`, `["reflection"]`, …) instead.
     */
    readonly pluginId: string;
    readonly description: string;
    readonly inputSchema: object;
    /**
     * Curated groups this tool joins, in addition to the
     * identity-derived auto-group for its `pluginId`. Mirrors
     * `PluginTool.groups`. The container folds each name into the
     * per-group key map its `ToolsFactory` consults, so e.g.
     * `groups: ["core"]` on a plugin tool adds its key to the
     * implicit-default `core` set.
     */
    readonly groups: readonly string[];
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
 * keys through verbatim and a handler's `tools:` treats each plugin
 * id as a group via the supplied {@link pluginKeysById} map.
 */
export class PluginToolsClient {
    private readonly config: PluginToolsClientConfig;

    constructor(config: PluginToolsClientConfig) {
        this.config = config;
    }

    /**
     * Fetch the live catalog and return a tool set whose `execute`
     * callbacks POST back to the gateway with `eventId`,
     * `agentrunId`, and the resolved offloading limit already bound.
     * Empty catalog → empty set.
     *
     * The second return value maps plugin id → set of that plugin's
     * sanitized tool keys, threaded into {@link
     * import("../tools/ToolsFactory").ToolsFactory}'s `builtins` so a
     * handler's `tools:` can reference a plugin id as a group
     * (`tools: core, mail`).
     */
    async tools(
        eventId: string,
        agentrunId: string,
        toolCallOffloadingLimit: number,
    ): Promise<{
        tools: ToolSet;
        keysById: ReadonlyMap<string, ReadonlySet<string>>;
        groupKeys: ReadonlyMap<string, ReadonlySet<string>>;
    }> {
        const catalog = await this.fetchCatalog();
        const toolSet: ToolSet = {};
        const keysById = new Map<string, Set<string>>();
        const groupKeys = new Map<string, Set<string>>();
        for (const entry of catalog) {
            toolSet[entry.key] = tool({
                description: entry.description,
                inputSchema: jsonSchema(entry.inputSchema),
                execute: async (args: unknown) =>
                    this.invoke(entry.key, args, eventId, agentrunId, toolCallOffloadingLimit),
            });
            // The `core` sentinel is a registration handle, not an
            // addressable plugin id — skip its auto-group so it can't
            // shadow the curated `core` group in the evaluator's
            // `builtins`. Host-owned tools join groups via `groups`.
            if (entry.pluginId !== CORE_PLUGIN_ID) {
                let perPlugin = keysById.get(entry.pluginId);
                if (perPlugin === undefined) {
                    perPlugin = new Set();
                    keysById.set(entry.pluginId, perPlugin);
                }
                perPlugin.add(entry.key);
            }
            for (const group of entry.groups) {
                let perGroup = groupKeys.get(group);
                if (perGroup === undefined) {
                    perGroup = new Set();
                    groupKeys.set(group, perGroup);
                }
                perGroup.add(entry.key);
            }
        }
        return { tools: toolSet, keysById, groupKeys };
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
                typeof (item as { pluginId?: unknown }).pluginId === "string" &&
                typeof (item as { description?: unknown }).description === "string" &&
                typeof (item as { inputSchema?: unknown }).inputSchema === "object" &&
                (item as { inputSchema?: unknown }).inputSchema !== null
            ) {
                const raw = item as {
                    key: string;
                    pluginId: string;
                    description: string;
                    inputSchema: object;
                    groups?: unknown;
                };
                const groups: string[] = [];
                if (Array.isArray(raw.groups)) {
                    for (const g of raw.groups) {
                        if (typeof g === "string") {
                            groups.push(g);
                        }
                    }
                }
                out.push({
                    key: raw.key,
                    pluginId: raw.pluginId,
                    description: raw.description,
                    inputSchema: raw.inputSchema,
                    groups,
                });
            }
        }
        return out;
    }

    /**
     * POST the call to the gateway. The response body is the runner's
     * output verbatim: either the bare success value (which we return
     * straight to the AI SDK) or `{ok:false, code, message, status?}`
     * — which we reconstruct into a {@link ToolError} and **throw**.
     * Transport faults (5xx, parse errors) throw a synthesised
     * `ToolError("Transport", …)` for the same reason: every failure
     * mode becomes a `tool-error` block in the agent's transcript.
     */
    private async invoke(
        key: string,
        args: unknown,
        eventId: string,
        agentrunId: string,
        toolCallOffloadingLimit: number,
    ): Promise<unknown> {
        const url = `${this.config.bastionUrl.replace(/\/$/, "")}/plugin-tools/${encodeURIComponent(key)}`;
        let res: Response;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ args, eventId, agentrunId, toolCallOffloadingLimit }),
            });
        } catch (err) {
            throw new ToolError(
                "Transport",
                `plugin tool ${key} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new ToolError(
                "Transport",
                `plugin tool ${key} HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`,
                res.status,
            );
        }
        let body: unknown;
        try {
            body = await res.json();
        } catch (err) {
            throw new ToolError(
                "Transport",
                `plugin tool ${key} returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        if (isFailureBody(body)) {
            this.config.log.warn(
                { tool: key, code: body.code, status: body.status, message: body.message },
                "plugin tool error",
            );
            throw new ToolError(body.code, body.message, body.status);
        }
        return body;
    }
}

/**
 * Type-guard for the failure shape the host gateway uses on the wire:
 * `{ok:false, code, message, status?}`. Returned bodies missing `ok`
 * are treated as success — that's the no-wrap success contract.
 */
function isFailureBody(
    body: unknown,
): body is { ok: false; code: string; message: string; status?: number } {
    if (body === null || typeof body !== "object") {
        return false;
    }
    const ok = (body as { ok?: unknown }).ok;
    if (ok !== false) {
        return false;
    }
    const code = (body as { code?: unknown }).code;
    const message = (body as { message?: unknown }).message;
    return typeof code === "string" && typeof message === "string";
}
