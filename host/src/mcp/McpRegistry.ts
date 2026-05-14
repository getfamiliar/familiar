import type { Logger, McpInfo } from "effective-assistant-shared";
import { loadMcpEntries } from "./McpConfigLoader.js";
import type { McpEntries, McpEntry } from "./McpEntry.js";

/**
 * Single in-process source of truth for the parsed `mcp.yml`. The
 * gateway needs the entries to build transports; the
 * {@link PluginMcpService} needs them to project metadata and route
 * `getByPackage` lookups. Sharing one parse avoids two consumers
 * loading the same file at boot.
 *
 * Constructed once during host bootstrap and passed to both
 * consumers. The class is read-only past construction — the file is
 * parsed eagerly so any error fails fast at daemon boot rather than
 * on first plugin call.
 */
export class McpRegistry {
    private readonly entries: McpEntries;

    constructor(mcpConfigFile: string, log: Logger) {
        this.entries = loadMcpEntries(mcpConfigFile, log);
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
