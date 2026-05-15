import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import { type Logger, sanitizeToolKey } from "effective-assistant-shared";

/**
 * Configuration for {@link McpClientPool}. Built from the agent's env
 * (`BASTION_URL`) plus the daemon-supplied logger.
 */
export interface McpClientPoolConfig {
    /**
     * Bastion base URL — what the agent dials for everything privileged.
     * The pool issues `GET ${bastionUrl}/mcp` for the catalog and
     * connects each client to `${bastionUrl}/mcp/<id>/`.
     */
    readonly bastionUrl: string;
    /** Logger child the pool writes lifecycle events to. */
    readonly log: Logger;
}

/**
 * One catalog entry as the bastion exposes it on `GET /mcp`. The pool
 * trusts the bastion's validation (which already ran against
 * `mcp.yml`) and only needs the id.
 */
interface CatalogEntry {
    readonly id: string;
    readonly title: string;
    readonly description: string;
}

/** Internal record per declared MCP after the pool has connected. */
interface PooledClient {
    readonly id: string;
    readonly title: string;
    readonly client: MCPClient;
    readonly tools: ToolSet;
}

/**
 * Container-side pool of `@ai-sdk/mcp` clients, one per declared MCP.
 *
 * Lifecycle: at agent boot, {@link start} fetches the bastion's
 * `/mcp` catalog, spins up an MCP client per id over Streamable HTTP,
 * and pre-fetches each client's tool set. Per-agentrun the
 * {@link tools} method returns a merged, namespaced `ToolSet` that is
 * passed straight into `ToolsFactory.build`. {@link close} tears down
 * every client during container shutdown.
 *
 * Tool naming: each MCP tool is registered as `${id}_${toolName}`.
 * Our id regex (`^[a-z0-9][a-z0-9-]*$`) bans underscores so the
 * delimiter is unambiguous, and the tool's own `description` is left
 * intact so the LLM still sees the original wording.
 *
 * Cold-start cost: every client's first `tools()` call cold-spawns
 * the bastion-side child. With a small catalog this is fine; once
 * the catalog grows, the bastion will gain a tool-list cache that
 * survives child idle-reaps so this stays cheap.
 */
export class McpClientPool {
    private readonly config: McpClientPoolConfig;
    private clients: PooledClient[] = [];
    private merged: ToolSet = {};
    private keysById: Map<string, ReadonlySet<string>> = new Map();

    constructor(config: McpClientPoolConfig) {
        this.config = config;
    }

    /**
     * Discover declared MCPs via the bastion's catalog endpoint and
     * connect one client per id, caching their tool sets. Errors
     * during a single client's setup are logged and skipped — one
     * misbehaving MCP must not prevent the agent from booting.
     */
    async start(): Promise<void> {
        const catalog = await this.fetchCatalog();
        if (catalog.length === 0) {
            this.config.log.info("no MCPs in catalog; pool empty");
            return;
        }
        const settled = await Promise.allSettled(catalog.map((entry) => this.connectOne(entry)));
        for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            const entry = catalog[i];
            if (result.status === "fulfilled" && result.value !== null) {
                this.clients.push(result.value);
            } else if (result.status === "rejected") {
                const reason =
                    result.reason instanceof Error ? result.reason.message : String(result.reason);
                this.config.log.error(
                    `mcp client '${entry.id}' failed to start, skipping: ${reason}`,
                );
            }
        }
        const merge = this.buildMergedAndIndex();
        this.merged = merge.merged;
        this.keysById = merge.keysById;
        const totalTools = countTools(this.merged);
        const breakdown = this.clients
            .map(
                (c) =>
                    `  ${c.id} — ${countTools(c.tools)} tool${countTools(c.tools) === 1 ? "" : "s"}`,
            )
            .join("\n");
        this.config.log.info(
            `mcp client pool initialized: ${totalTools} tool${totalTools === 1 ? "" : "s"} across ${this.clients.length} server${this.clients.length === 1 ? "" : "s"}\n${breakdown}`,
        );
    }

    /**
     * Merged, namespaced tool set across every connected MCP. Safe to
     * call before {@link start} (returns an empty set) and after
     * {@link close} (also empty).
     */
    tools(): ToolSet {
        return this.merged;
    }

    /**
     * Map of MCP id → that MCP's sanitized tool keys. The host's
     * `mcp.yml` linter constrains ids to alnum-only, so the id
     * itself is already a valid tools-DSL group name and no fold
     * is needed; only the tool keys (which prepend a tool name
     * possibly carrying hyphens) pass through `sanitizeToolKey`.
     *
     * The container threads this into {@link
     * import("../tools/ToolsFactory").ToolsFactory}'s `builtins`
     * map so a handler's `tools:` expression can reference an MCP
     * id directly (`tools: fetch + atlassian`) without a
     * user-written toolgroup file. Reserved names (`all`, `system`,
     * `mcp`, `none`) cannot collide because the linter rejects
     * them as ids up front.
     */
    mcpKeysById(): ReadonlyMap<string, ReadonlySet<string>> {
        return this.keysById;
    }

    /** Close every client. Per-client failures are logged and swallowed. */
    async close(): Promise<void> {
        await Promise.allSettled(
            this.clients.map(async (c) => {
                try {
                    await c.client.close();
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.config.log.error(`mcp client '${c.id}' close error: ${message}`);
                }
            }),
        );
        this.clients = [];
        this.merged = {};
        this.keysById = new Map();
    }

    /**
     * Fetch and parse the bastion's `/mcp/` catalog. Trailing slash is
     * required: the bastion's HTTP router matches by prefix-with-slash
     * to avoid `/mcp` accidentally matching `/mcpFoo`.
     */
    private async fetchCatalog(): Promise<CatalogEntry[]> {
        const url = `${this.config.bastionUrl.replace(/\/$/, "")}/mcp/`;
        const res = await fetch(url, { method: "GET" });
        if (!res.ok) {
            throw new Error(`fetch ${url} → ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as unknown;
        if (!Array.isArray(body)) {
            throw new Error(`bastion /mcp returned non-array body`);
        }
        const out: CatalogEntry[] = [];
        for (const item of body) {
            if (
                item !== null &&
                typeof item === "object" &&
                typeof (item as { id?: unknown }).id === "string" &&
                typeof (item as { title?: unknown }).title === "string" &&
                typeof (item as { description?: unknown }).description === "string"
            ) {
                const e = item as CatalogEntry;
                out.push({ id: e.id, title: e.title, description: e.description });
            }
        }
        return out;
    }

    /**
     * Build one MCP client over Streamable HTTP, fetch its tools, and
     * return the pooled record. Returns `null` when the per-client
     * setup throws after we've already logged the cause — kept as a
     * branch to keep `start()`'s error-aggregation simple.
     */
    private async connectOne(entry: CatalogEntry): Promise<PooledClient> {
        const url = `${this.config.bastionUrl.replace(/\/$/, "")}/mcp/${entry.id}/`;
        const client = await createMCPClient({
            transport: { type: "http", url },
            clientName: "effective-assistant",
        });
        const tools = await client.tools();
        return { id: entry.id, title: entry.title, client, tools };
    }

    /**
     * Build the merged tool set with `${id}_${toolName}` keys, with
     * every non-alnum-underscore character replaced by `_`. The
     * sanitization step matters because some open-source LLMs
     * (notably GLM 5.1, several Qwen variants, others) emit tool
     * calls in a grammar that doesn't recognize hyphens in tool
     * names — the model still *reasons* about calling
     * `ms365_verify-login`, but its function-call decoder drops the
     * call and the AI SDK reports `finishReason: "other"` with
     * zero parsed calls. By registering the tool under
     * `ms365_verify_login` instead, the model emits a name its
     * decoder accepts and the call routes through cleanly. The
     * back-map happens implicitly: the AI SDK looks up the tool by
     * key, and the underlying `Tool` object knows nothing about
     * its registered name — it executes against the real MCP tool
     * either way.
     *
     * Collisions across MCPs are impossible by construction since
     * the id is part of every key. Collisions *within* a single
     * MCP that happen to differ only in non-alnum punctuation
     * (e.g. `verify-login` and `verify_login`) are theoretically
     * possible but unobserved; if they ever crop up we can add a
     * suffix-disambiguation pass.
     */
    private buildMergedAndIndex(): {
        merged: ToolSet;
        keysById: Map<string, ReadonlySet<string>>;
    } {
        const merged: ToolSet = {};
        const keysById = new Map<string, ReadonlySet<string>>();
        for (const c of this.clients) {
            const idKeys = new Set<string>();
            for (const [toolName, tool] of Object.entries(c.tools)) {
                const key = sanitizeToolKey(`${c.id}_${toolName}`);
                merged[key] = tool;
                idKeys.add(key);
            }
            keysById.set(c.id, idKeys);
        }
        return { merged, keysById };
    }
}

/** Count keys on a ToolSet without leaking `Object.keys` allocations elsewhere. */
function countTools(tools: ToolSet): number {
    return Object.keys(tools).length;
}
