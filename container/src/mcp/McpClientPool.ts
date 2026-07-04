import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { type Logger, matchesAnyToolPattern, type ToolLevel } from "@getfamiliar/shared";
import type { ToolSet } from "ai";

/**
 * Configuration for {@link McpClientPool}. Built from the passed config
 * (`bastionUrl`) plus the daemon-supplied logger.
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
    private levelsByKey: Map<string, ToolLevel> = new Map();

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
        this.levelsByKey = merge.levelsByKey;
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
        this.levelsByKey = new Map();
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
                const e = item as Record<string, unknown>;
                out.push({
                    id: e.id as string,
                    title: e.title as string,
                    description: e.description as string,
                    allowlist: stringArray(e.allowlist),
                    denylist: stringArray(e.denylist),
                    approval: stringArray(e.approval),
                    privileged: stringArray(e.privileged),
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
            transport: { type: "http", url },
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
