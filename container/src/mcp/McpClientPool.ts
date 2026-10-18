import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { type Logger, matchesAnyToolPattern, type ToolLevel } from "@getfamiliar/shared";
import type { ToolSet } from "ai";
import { bastionAuthHeaders } from "../utils/BastionAuth.js";

/**
 * Configuration for {@link McpClientPool}. Built from the passed config
 * (`bastionUrl`, `bastionToken`) plus the daemon-supplied logger.
 */
export interface McpClientPoolConfig {
    /**
     * Bastion base URL — what the agent dials for everything privileged.
     * The pool issues `GET ${bastionUrl}/mcp` for the catalog and
     * connects each client to `${bastionUrl}/mcp/<id>/`.
     */
    readonly bastionUrl: string;
    /** Shared bastion token (passed config `bastionToken`), sent on every request. */
    readonly bastionToken: string;
    /** Logger child the pool writes lifecycle events to. */
    readonly log: Logger;
}

/**
 * Per-MCP tool-gating globs, resolved container-side. Mirrors the
 * `allowlist` / `denylist` / `approval` / `privileged` fields on the
 * host's `McpEntry`, delivered verbatim on the `/mcp` catalog.
 */
export interface McpToolGating {
    readonly allowlist: readonly string[];
    readonly denylist: readonly string[];
    readonly approval: readonly string[];
    readonly privileged: readonly string[];
}

/**
 * Apply one MCP's gating to a single bare tool name, in order:
 * allowlist → denylist → approval → privileged.
 *
 * @returns the tool's {@link ToolLevel} if it survives allow/deny, or
 *   `null` if it should be dropped (allowlist miss or denylist hit).
 *   `privileged` is evaluated after `approval`, so a tool matching both
 *   ends up `privileged`.
 */
export function gateMcpTool(toolName: string, gating: McpToolGating): ToolLevel | null {
    if (gating.allowlist.length > 0 && !matchesAnyToolPattern(gating.allowlist, toolName)) {
        return null;
    }
    if (matchesAnyToolPattern(gating.denylist, toolName)) {
        return null;
    }
    let level: ToolLevel = "default";
    if (matchesAnyToolPattern(gating.approval, toolName)) {
        level = "approval";
    }
    if (matchesAnyToolPattern(gating.privileged, toolName)) {
        level = "privileged";
    }
    return level;
}

/**
 * One catalog entry as the bastion exposes it on `GET /mcp`. The pool
 * trusts the bastion's validation (which already ran against
 * `mcp.yml`) and needs the id plus the four tool-gating glob lists.
 */
interface CatalogEntry extends McpToolGating {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    /** Bumped by the host whenever a reload rebuilds this id's transport. */
    readonly generation: number;
}

/** Internal record per declared MCP after the pool has connected. */
interface PooledClient extends McpToolGating {
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
 * and pre-fetches each client's tool set. Per agentrun,
 * {@link refreshIfChanged} re-reads the catalog and reconnects only the
 * ids a host config reload added or rebuilt; then the {@link tools}
 * method returns a merged, namespaced `ToolSet` that is passed straight
 * into `ToolsFactory.build`. {@link close} tears down every client
 * during container shutdown.
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
    private levelsByKey: Map<string, ToolLevel> = new Map();
    /** Catalog generation last attempted per id, whether the connect succeeded or not. */
    private readonly attemptedGenerations = new Map<string, number>();
    /** The refresh in progress, shared by concurrent {@link refreshIfChanged} callers. */
    private refreshing: Promise<void> | undefined;

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
        await this.refreshIfChanged();
    }

    /**
     * Bring the pool in line with the bastion's catalog after a host
     * config reload. Called once per agentrun (cheap: one catalog GET).
     * Ids that disappeared are closed; ids that are new or whose
     * `generation` changed (the host rebuilt their transport, so the old
     * session is stale) are (re)connected; everything else is untouched.
     * An id that failed to connect is retried only once its generation
     * changes, so a broken MCP doesn't cost a spawn attempt per run.
     *
     * Concurrent callers share one refresh. A catalog fetch failure is
     * logged and leaves the pool as it is.
     */
    async refreshIfChanged(): Promise<void> {
        if (this.refreshing === undefined) {
            this.refreshing = this.refresh().finally(() => {
                this.refreshing = undefined;
            });
        }
        await this.refreshing;
    }

    /** Worker for {@link refreshIfChanged}. */
    private async refresh(): Promise<void> {
        let catalog: CatalogEntry[];
        try {
            catalog = await this.fetchCatalog();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.config.log.warn(`mcp catalog fetch failed, keeping current pool: ${message}`);
            return;
        }
        const catalogIds = new Set(catalog.map((entry) => entry.id));
        const stale = catalog.filter(
            (entry) => this.attemptedGenerations.get(entry.id) !== entry.generation,
        );
        const removedIds = [...this.attemptedGenerations.keys()].filter(
            (id) => !catalogIds.has(id),
        );
        if (stale.length === 0 && removedIds.length === 0) {
            return;
        }
        const dropIds = new Set([...removedIds, ...stale.map((entry) => entry.id)]);
        await this.closeClients(this.clients.filter((c) => dropIds.has(c.id)));
        this.clients = this.clients.filter((c) => !dropIds.has(c.id));
        for (const id of removedIds) {
            this.attemptedGenerations.delete(id);
        }

        const settled = await Promise.allSettled(stale.map((entry) => this.connectOne(entry)));
        for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            const entry = stale[i];
            this.attemptedGenerations.set(entry.id, entry.generation);
            if (result.status === "fulfilled") {
                this.clients.push(result.value);
            } else {
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
        this.levelsByKey = merge.levelsByKey;
        const totalTools = countTools(this.merged);
        const breakdown = this.clients
            .map(
                (c) =>
                    `  ${c.id} — ${countTools(c.tools)} tool${countTools(c.tools) === 1 ? "" : "s"}`,
            )
            .join("\n");
        const changes = removedIds.length > 0 ? ` (removed: ${removedIds.join(", ")})` : "";
        this.config.log.info(
            `mcp client pool synced with catalog: ${totalTools} tool${totalTools === 1 ? "" : "s"} across ${this.clients.length} server${this.clients.length === 1 ? "" : "s"}, (re)connected ${stale.map((e) => e.id).join(", ") || "none"}${changes}\n${breakdown}`,
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
     * Map of MCP id → that MCP's namespaced tool keys (`${id}_${name}`,
     * verbatim). The host's `mcp.yml` linter constrains ids to
     * alnum-only, so the id itself is already a valid tool group name.
     *
     * The container threads this into {@link
     * import("../tools/ToolsFactory").ToolsFactory}'s `builtins`
     * map so a handler's `tools:` can reference an MCP id directly
     * (`tools: fetch, atlassian`). Reserved names (`all`, `mcp`,
     * `none`) cannot collide because the linter rejects them as ids
     * up front.
     */
    mcpKeysById(): ReadonlyMap<string, ReadonlySet<string>> {
        return this.keysById;
    }

    /**
     * Map of namespaced MCP tool key (`${id}_${name}`) → its resolved
     * security {@link ToolLevel}, for tools whose per-MCP `approval` /
     * `privileged` globs matched. `default`-level tools are omitted
     * (the {@link import("../tools/ToolsFactory").ToolsFactory} level
     * lookup falls back to `default`). Threaded into `ToolsFactory` so
     * the tool wrapper refuses a non-`default` MCP tool in a
     * non-privileged run, exactly like plugin tools.
     */
    mcpLevelsByKey(): ReadonlyMap<string, ToolLevel> {
        return this.levelsByKey;
    }

    /** Close every client. Per-client failures are logged and swallowed. */
    async close(): Promise<void> {
        await this.closeClients(this.clients);
        this.clients = [];
        this.attemptedGenerations.clear();
        this.merged = {};
        this.keysById = new Map();
        this.levelsByKey = new Map();
    }

    /**
     * Close the given clients in parallel; per-client failures are logged.
     *
     * @param clients The pooled clients to close.
     */
    private async closeClients(clients: readonly PooledClient[]): Promise<void> {
        await Promise.allSettled(
            clients.map(async (c) => {
                try {
                    await c.client.close();
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.config.log.error(`mcp client '${c.id}' close error: ${message}`);
                }
            }),
        );
    }

    /**
     * Fetch and parse the bastion's `/mcp/` catalog. Trailing slash is
     * required: the bastion's HTTP router matches by prefix-with-slash
     * to avoid `/mcp` accidentally matching `/mcpFoo`.
     */
    private async fetchCatalog(): Promise<CatalogEntry[]> {
        const url = `${this.config.bastionUrl.replace(/\/$/, "")}/mcp/`;
        const res = await fetch(url, {
            method: "GET",
            headers: bastionAuthHeaders(this.config.bastionToken),
        });
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
                const e = item as Record<string, unknown>;
                out.push({
                    id: e.id as string,
                    title: e.title as string,
                    description: e.description as string,
                    allowlist: stringArray(e.allowlist),
                    denylist: stringArray(e.denylist),
                    approval: stringArray(e.approval),
                    privileged: stringArray(e.privileged),
                    generation: typeof e.generation === "number" ? e.generation : 0,
                });
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
            transport: { type: "http", url, headers: bastionAuthHeaders(this.config.bastionToken) },
            clientName: "familiar",
        });
        const tools = await client.tools();
        return {
            id: entry.id,
            title: entry.title,
            client,
            tools,
            allowlist: entry.allowlist,
            denylist: entry.denylist,
            approval: entry.approval,
            privileged: entry.privileged,
        };
    }

    /**
     * Build the merged tool set with verbatim `${id}_${toolName}` keys,
     * applying each MCP's `mcp.yml` tool gating in order: allowlist →
     * denylist → approval → privileged (bare tool name matched against
     * the globs). Dropped tools (allowlist miss / denylist hit) are
     * excluded entirely — invisible to the agent. Surviving tools that
     * match `approval` / `privileged` are recorded in `levelsByKey`
     * (privileged evaluated last, so it wins on overlap); the rest are
     * `default` (omitted).
     *
     * Tool names pass through unchanged — including any hyphens
     * (`ms365_verify-login`), which are valid in the OpenAI / Anthropic
     * function-name grammar. The AI SDK looks each tool up by its
     * registered key and the underlying `Tool` object executes against
     * the real MCP tool regardless of the key, so no back-map is
     * needed. Collisions across MCPs are impossible by construction
     * since the id is part of every key.
     */
    private buildMergedAndIndex(): {
        merged: ToolSet;
        keysById: Map<string, ReadonlySet<string>>;
        levelsByKey: Map<string, ToolLevel>;
    } {
        const merged: ToolSet = {};
        const keysById = new Map<string, ReadonlySet<string>>();
        const levelsByKey = new Map<string, ToolLevel>();
        for (const c of this.clients) {
            const idKeys = new Set<string>();
            let dropped = 0;
            for (const [toolName, tool] of Object.entries(c.tools)) {
                const level = gateMcpTool(toolName, c);
                if (level === null) {
                    dropped++;
                    continue;
                }
                const key = `${c.id}_${toolName}`;
                merged[key] = tool;
                idKeys.add(key);
                if (level !== "default") {
                    levelsByKey.set(key, level);
                }
            }
            keysById.set(c.id, idKeys);
            if (dropped > 0) {
                this.config.log.info(
                    `mcp '${c.id}': ${idKeys.size} tool${idKeys.size === 1 ? "" : "s"} exposed, ${dropped} dropped by allow/deny gating`,
                );
            }
        }
        return { merged, keysById, levelsByKey };
    }
}

/**
 * Coerce an unknown catalog value to a string array, dropping non-string
 * elements. Absent/malformed ⇒ `[]` (no gating). Defensive: the host
 * lints `mcp.yml`, but the pool never trusts the wire blindly.
 */
function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((v): v is string => typeof v === "string");
}

/** Count keys on a ToolSet without leaking `Object.keys` allocations elsewhere. */
function countTools(tools: ToolSet): number {
    return Object.keys(tools).length;
}
