import { type Logger, ToolError } from "@getfamiliar/shared";
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
     * Plugin id this tool belongs to, or the reserved string `"core"`
     * for host-owned tools registered without a plugin-id prefix
     * (e.g. the `cal_*` calendar tools). Used to bucket keys into the
     * DSL group map so a handler's `tools: core` resolves to every
     * host-owned tool.
     */
    readonly pluginId: string;
    readonly description: string;
    readonly inputSchema: object;
    /**
     * Plugin author flagged this tool as belonging to the `system` DSL
     * group (and thus the implicit default tool set). Mirrors
     * `PluginTool.system` from the shared manifest; defaults to `false`
     * when the bastion serves an older catalog without the field.
     */
    readonly system: boolean;
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
     * callbacks POST back to the gateway with `eventId`,
     * `agentrunId`, and the resolved offloading limit already bound.
     * Empty catalog → empty set.
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
        toolCallOffloadingLimit: number,
    ): Promise<{
        tools: ToolSet;
        keysById: ReadonlyMap<string, ReadonlySet<string>>;
        systemKeys: ReadonlySet<string>;
    }> {
        const catalog = await this.fetchCatalog();
        const toolSet: ToolSet = {};
        const keysById = new Map<string, Set<string>>();
        const systemKeys = new Set<string>();
        for (const entry of catalog) {
            toolSet[entry.key] = tool({
                description: entry.description,
                inputSchema: jsonSchema(entry.inputSchema),
                execute: async (args: unknown) =>
                    this.invoke(entry.key, args, eventId, agentrunId, toolCallOffloadingLimit),
            });
            let set = keysById.get(entry.pluginId);
            if (set === undefined) {
                set = new Set();
                keysById.set(entry.pluginId, set);
            }
            set.add(entry.key);
            if (entry.system) {
                systemKeys.add(entry.key);
            }
        }
        const frozen = new Map<string, ReadonlySet<string>>();
        for (const [id, keys] of keysById) {
            frozen.set(id, keys);
        }
        return { tools: toolSet, keysById: frozen, systemKeys };
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
                const e = item as Partial<CatalogEntry> & {
                    key: string;
                    pluginId: string;
                    description: string;
                    inputSchema: object;
                };
                out.push({
                    key: e.key,
                    pluginId: e.pluginId,
                    description: e.description,
                    inputSchema: e.inputSchema,
                    // Defaults to false when the field is missing
                    // (older host serving older catalog) — preserves
                    // the pre-`system: true` behavior on rolling
                    // upgrades.
                    system: e.system === true,
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
