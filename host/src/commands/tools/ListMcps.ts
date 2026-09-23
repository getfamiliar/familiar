import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { markdownTable, writeMarkdown } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { parse } from "yaml";
import { bootstrap } from "../../Bootstrap.js";
import { dockerCapture } from "../../utils/DockerTools.js";
import { lintMcpConfigFile } from "../../mcp/McpConfigLoader.js";
import { mcpMountDirFor } from "../../mcp/RuntimeImages.js";

/**
 * `familiar tools list-mcps` — print every MCP declared in `config/mcp.yml`,
 * its source, runtime state, and the relevant identifier (image,
 * package@version, or url). Read-only; safe to run any time.
 *
 * State derivation:
 * - `live` — `docker ps --filter name=familiar-mcp-` shows the
 *   per-id container.
 * - `idle` — declared but no live container.
 *
 * The `(cached)` annotation appears next to npm/pypi entries when
 * `tmp/mcp-mount-<id>/` exists and contains anything; lets the user
 * see at a glance whether `tools purge-mcps` would actually free space.
 *
 * Failure modes:
 * - `mcp.yml` missing/empty → "no MCPs declared", exit 0.
 * - `mcp.yml` malformed → lint errors to stderr, exit 1 (the file
 *   wouldn't load at daemon start either).
 * - docker unreachable → trailing note, all entries shown idle.
 */
export const listMcpsCommand = defineCommand({
    meta: {
        name: "list-mcps",
        description:
            "List declared MCPs, their source, live/idle state, and (for npm/pypi) cache presence.",
    },
    args: {
        raw: {
            type: "boolean",
            description:
                "Skip terminal styling and emit the raw markdown verbatim. Useful for piping into a file or a markdown viewer.",
            default: false,
        },
    },
    async run({ args }) {
        const raw = args.raw === true;
        const boot = bootstrap();
        if (!existsSync(boot.mcpConfigFile)) {
            writeMarkdown("no MCPs declared (config/mcp.yml not present)\n", { raw });
            return;
        }

        const lint = lintMcpConfigFile(boot.mcpConfigFile);
        for (const w of lint.warnings) {
            process.stderr.write(`warning: ${w}\n`);
        }
        if (!lint.ok) {
            for (const e of lint.errors) {
                process.stderr.write(`error: ${e}\n`);
            }
            process.exit(1);
        }

        const rows = collectRows(boot.mcpConfigFile);
        if (rows.length === 0) {
            writeMarkdown("no MCPs declared\n", { raw });
            return;
        }

        const live = await probeLiveSet();

        for (const row of rows) {
            row.state = live.containers.has(`familiar-mcp-${row.id}`) ? "live" : "idle";
            if (row.source === "npm" || row.source === "pypi") {
                if (isMountCached(boot.tmpDir, row.id)) {
                    row.detail = `${row.detail} (cached)`;
                }
            }
        }

        writeMarkdown(renderTable(rows, live.dockerReachable), { raw });
    },
});

/** One displayable row of the table. Built before live/cache annotations. */
interface ListRow {
    id: string;
    title: string;
    source: string;
    state: "live" | "idle";
    detail: string;
}

/**
 * Re-parse `mcp.yml` (lint-validated by the caller) and pull out the
 * minimal projection needed for display. Doing this here keeps the
 * subcommand free of the {@link loadMcpEntries} logger dependency.
 */
function collectRows(filePath: string): ListRow[] {
    const raw = readFileSync(filePath, "utf-8");
    const root = parse(raw);
    if (root === null || root === undefined || typeof root !== "object" || Array.isArray(root)) {
        return [];
    }
    const rows: ListRow[] = [];
    for (const [id, value] of Object.entries(root as Record<string, unknown>)) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            continue;
        }
        const entry = value as Record<string, unknown>;
        const source = typeof entry.source === "string" ? entry.source : "?";
        const title = typeof entry.title === "string" ? entry.title : "";
        rows.push({
            id,
            title,
            source,
            state: "idle",
            detail: detailFor(entry, source),
        });
    }
    return rows;
}

/**
 * Build the source-specific identifier column. `package@version` for
 * npm/pypi (using the appropriate separator), `image` for
 * docker-mcp-registry, `url` for external, and a literal `?` when
 * none of those fields are populated (lint would have caught this).
 */
function detailFor(entry: Record<string, unknown>, source: string): string {
    if (source === "docker-mcp-registry") {
        return typeof entry.image === "string" ? entry.image : "?";
    }
    if (source === "npm" || source === "pypi") {
        const pkg = typeof entry.package === "string" ? entry.package : "?";
        if (typeof entry.version === "string" && entry.version.length > 0) {
            const sep = source === "npm" ? "@" : "==";
            return `${pkg}${sep}${entry.version}`;
        }
        return pkg;
    }
    if (source === "external") {
        return typeof entry.url === "string" ? entry.url : "?";
    }
    return "?";
}

/**
 * Snapshot the set of currently-running `familiar-mcp-*` container names
 * via a single `docker ps`. `dockerReachable: false` when docker
 * fails (daemon stopped, cli missing) — the caller turns this into
 * the trailing note + every-row-idle behavior.
 */
async function probeLiveSet(): Promise<{
    containers: ReadonlySet<string>;
    dockerReachable: boolean;
}> {
    try {
        const result = await dockerCapture([
            "ps",
            "--filter",
            "name=familiar-mcp-",
            "--format",
            "{{.Names}}",
        ]);
        if (result.code !== 0) {
            return { containers: new Set(), dockerReachable: false };
        }
        const names = result.stdout
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        return { containers: new Set(names), dockerReachable: true };
    } catch {
        return { containers: new Set(), dockerReachable: false };
    }
}

/**
 * `true` if `tmp/mcp-mount-<id>/` exists and is non-empty. Only
 * called for npm/pypi rows since those are the only sources that
 * use the bind-mount cache.
 */
function isMountCached(tmpDir: string, id: string): boolean {
    const dir = mcpMountDirFor(tmpDir, id);
    if (!existsSync(dir)) {
        return false;
    }
    try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) {
            return false;
        }
        return readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}

/**
 * Render the MCP rows as a markdown document: a GFM table plus, when
 * docker could not be reached, a trailing italic note explaining that the
 * live/idle column is unreliable.
 *
 * @param rows - the collected MCP rows (with live/cache annotations applied)
 * @param dockerReachable - whether the `docker ps` probe succeeded
 * @returns markdown source for {@link writeMarkdown}
 */
function renderTable(rows: readonly ListRow[], dockerReachable: boolean): string {
    const table = markdownTable(
        ["ID", "TITLE", "SOURCE", "STATE", "DETAIL"],
        rows.map((r) => [r.id, r.title, r.source, r.state, r.detail]),
    );
    if (dockerReachable) {
        return table;
    }
    return `${table}\n_(docker unreachable; live state unknown — all shown idle)_\n`;
}
