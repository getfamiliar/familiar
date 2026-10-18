import type { Logger, McpInfo } from "@getfamiliar/shared";
import { loadMcpEntries } from "./McpConfigLoader.js";
import type { McpEntries, McpEntry } from "./McpEntry.js";

/**
 * Which MCP ids a reload of `mcp.yml` added, removed or changed. An
 * entry counts as changed when any of its materialized fields differ
 * (env, args, gating, …) — the gateway rebuilds its transport.
 */
export interface McpDiff {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
}

/**
 * Single in-process source of truth for the parsed `mcp.yml`. The
 * gateway needs the entries to build transports; the
 * {@link PluginMcpService} needs them to project metadata and route
 * `getByPackage` lookups. Sharing one parse avoids two consumers
 * loading the same file at boot.
 *
 * Constructed once during host bootstrap and passed to both
 * consumers. The file is parsed eagerly so any error fails fast at
 * daemon boot rather than on first plugin call. {@link reload} swaps
 * the entries in place when the daemon reloads its configuration; the
 * gateway then applies the returned {@link McpDiff}.
 */
export class McpRegistry {
    private readonly mcpConfigFile: string;
    private readonly log: Logger;
    private entries: McpEntries;

    constructor(mcpConfigFile: string, log: Logger) {
        this.mcpConfigFile = mcpConfigFile;
        this.log = log;
        this.entries = loadMcpEntries(mcpConfigFile, log);
    }

    /**
     * Parse `mcp.yml` again and report what would change, without
     * swapping anything. Lets the reloader validate (e.g. id clashes
     * with plugin tool groups) before it commits.
     *
     * @returns The prospective diff against the current entries.
     * @throws If the file fails linting.
     */
    previewReload(): McpDiff {
        return diffMcpEntries(this.entries, loadMcpEntries(this.mcpConfigFile, this.log));
    }

    /**
     * Parse `mcp.yml` again and swap the entries.
     *
     * @returns Which ids were added, removed or changed.
     * @throws If the file fails linting; the current entries stay in place.
     */
    reload(): McpDiff {
        const next = loadMcpEntries(this.mcpConfigFile, this.log);
        const diff = diffMcpEntries(this.entries, next);
        this.entries = next;
        return diff;
    }

    /** Stable-order list of every parsed entry. */
    list(): readonly McpEntry[] {
        return [...this.entries.values()];
    }

    /** Lookup by the entry's `mcp.yml` key. */
    get(key: string): McpEntry | undefined {
        return this.entries.get(key);
    }

    /**
     * Entries whose {@link combinedPackage} equals `pkg`, optionally
     * narrowed first by source. Plural return so callers (e.g.
     * `getByPackage`) can detect ambiguity instead of silently
     * picking one.
     */
    findByPackage(pkg: string, source?: string): readonly McpEntry[] {
        const out: McpEntry[] = [];
        for (const entry of this.entries.values()) {
            if (source !== undefined && entry.source !== source) {
                continue;
            }
            if (this.combinedPackage(entry) === pkg) {
                out.push(entry);
            }
        }
        return out;
    }

    /**
     * Project an entry to its public `McpInfo`. The `package` field
     * folds three source-specific names into one:
     *
     * - `docker-mcp-registry` → `image`
     * - `npm` / `pypi`        → bare `package` (version dropped)
     * - `external`            → `url`
     */
    info(entry: McpEntry): McpInfo {
        return {
            key: entry.id,
            source: entry.source,
            package: this.combinedPackage(entry),
        };
    }

    /** Same projection as {@link info} but just the `package` string. */
    combinedPackage(entry: McpEntry): string {
        switch (entry.source) {
            case "docker-mcp-registry":
                return entry.image ?? "";
            case "npm":
            case "pypi":
                return entry.package ?? "";
            case "external":
                return entry.url ?? "";
            default:
                return "";
        }
    }
}

/**
 * Compare two entry maps by id. Entries are plain data, so a JSON
 * comparison of the materialized shape is a sufficient deep-equal.
 *
 * @param previous Entries before the reload.
 * @param next Entries after the reload.
 * @returns The diff, each list in `next` / `previous` iteration order.
 */
export function diffMcpEntries(previous: McpEntries, next: McpEntries): McpDiff {
    const added: string[] = [];
    const changed: string[] = [];
    for (const [id, entry] of next) {
        const before = previous.get(id);
        if (before === undefined) {
            added.push(id);
        } else if (JSON.stringify(before) !== JSON.stringify(entry)) {
            changed.push(id);
        }
    }
    const removed = [...previous.keys()].filter((id) => !next.has(id));
    return { added, removed, changed };
}
