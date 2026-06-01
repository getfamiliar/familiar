import type { AgentRunRow, EventContextProvider, EventRow, Logger } from "@getfamiliar/shared";
import type { MemoryConfig } from "./Config.js";
import type { MemoryHit, MemoryStore } from "./MemoryStore.js";
import { matchesAnyGlob } from "./PathGlob.js";

/**
 * Hard cap on time the contextProvider spends in `store.search`. The
 * host's `EventContextGateway` enforces a 5s per-provider timeout and
 * silently drops the section when exceeded; we cap below that so a
 * slow search surfaces its partial results instead of being discarded.
 */
const PROVIDER_TIMEOUT_MS = 4000;

/** Minimum prompt length worth searching for. */
const MIN_QUERY_LENGTH = 4;

const NO_HITS_SECTION = [
    "# Memories",
    "",
    "No memories matched the initial prompt. Use `memory_search` if you want to search for memories.",
].join("\n");

/** Placeholder description for a handler file with no `description:` frontmatter. */
const HANDLER_FILE_DESCRIPTION = "(Handler file)";

/** Hard cap on a sanitized description's length, in characters. */
const MAX_DESCRIPTION_LENGTH = 200;

/** One row of the injected `# Memories` table. */
interface MemoryTableRow {
    /** Workspace-relative path, e.g. `wiki/people/alice.md`. */
    readonly path: string;
    /** Best hybrid score for the file, as an integer percent in [0, 100]. */
    readonly scorePercent: number;
    /** Sanitized, length-capped plain-text description. */
    readonly description: string;
}

/**
 * EventContextProvider that searches memory using the agentrun's
 * prompt as the query and emits the `# Memories` section the agent
 * sees.
 *
 * Three states:
 *  - backend not ready → return `null` (no section, no "search ran"
 *    lie).
 *  - search ran but nothing cleared the score floor → emit the
 *    no-memories stub so the agent knows the index was consulted and
 *    that `memory_search` is the way to dig deeper.
 *  - hits → emit a flat table, one row per file, with a score and a
 *    short description. No chunk bodies are inlined; the agent reads
 *    full files on demand via `fs_read`.
 */
export function buildMemoryContextProvider(
    store: MemoryStore,
    cfg: MemoryConfig,
    log: Logger,
): EventContextProvider {
    return async (agentrun: AgentRunRow, _event: EventRow): Promise<string | null> => {
        if (!store.isReady()) {
            return null;
        }
        const query = (agentrun.prompt ?? "").trim();
        if (query.length < MIN_QUERY_LENGTH) {
            return null;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
        try {
            const hits = await store.search(query, {
                limit: cfg.maxSystemPromptMemoryResults,
                signal: controller.signal,
            });
            const rows = await buildTableRows(hits, cfg, store);
            if (rows.length === 0) {
                return NO_HITS_SECTION;
            }
            return formatMemoryTable(rows);
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                "memory: contextProvider search failed",
            );
            return null;
        } finally {
            clearTimeout(timer);
        }
    };
}

/**
 * Collapse per-chunk hits into one table row per file: keep the best
 * score, drop files at/below the score floor, sort by score desc, cap
 * at the configured result count, and resolve each file's description.
 *
 * Description source depends on whether the file is one of the
 * assistant's own writable memory files:
 *  - writable path → the file's first paragraph (`hit.context`), our
 *    memory convention. Falls back to the first content line when the
 *    file has no leading paragraph (headerless / list-first).
 *  - otherwise (handler files) → the YAML `description:` frontmatter,
 *    or the `(Handler file)` placeholder. We deliberately avoid the
 *    first paragraph here — handler bodies open with instruction prose
 *    that would pose as direction addressed at the agent.
 *
 * @param hits - Raw search hits, already score-sorted by Orama.
 * @param cfg - Memory config (score floor, writable paths, result cap).
 * @param store - Backend, used to read handler-file frontmatter.
 * @returns Table rows ready for {@link formatMemoryTable}.
 */
async function buildTableRows(
    hits: readonly MemoryHit[],
    cfg: MemoryConfig,
    store: MemoryStore,
): Promise<MemoryTableRow[]> {
    // Best hit per file, preserving Orama's score-descending first-seen
    // order so equal-best ties keep a stable order.
    const bestByPath = new Map<string, MemoryHit>();
    for (const hit of hits) {
        if (hit.score <= cfg.minScoreToMention) {
            continue;
        }
        const prior = bestByPath.get(hit.relativePath);
        if (!prior || hit.score > prior.score) {
            bestByPath.set(hit.relativePath, hit);
        }
    }
    const best = [...bestByPath.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, cfg.maxSystemPromptMemoryResults);

    const rows: MemoryTableRow[] = [];
    for (const hit of best) {
        const description = await resolveDescription(hit, cfg, store);
        rows.push({
            path: hit.relativePath,
            scorePercent: Math.round(hit.score * 100),
            description,
        });
    }
    return rows;
}

/**
 * Resolve the table description for a single file's best hit. See
 * {@link buildTableRows} for the writable-vs-handler rule.
 */
async function resolveDescription(
    hit: MemoryHit,
    cfg: MemoryConfig,
    store: MemoryStore,
): Promise<string> {
    if (matchesAnyGlob(cfg.writablePaths, hit.relativePath)) {
        const paragraph = hit.context.trim();
        if (paragraph.length > 0) {
            return sanitizeDescription(paragraph);
        }
        const firstLine = hit.snippet.trim().split("\n", 1)[0] ?? "";
        return sanitizeDescription(firstLine);
    }
    const frontmatter = await store.readFrontmatterDescription(hit.relativePath);
    if (frontmatter && frontmatter.trim().length > 0) {
        return sanitizeDescription(frontmatter);
    }
    return HANDLER_FILE_DESCRIPTION;
}

/**
 * Render table rows into the injected `# Memories` section. Pure — no
 * I/O — so it is unit-testable in isolation.
 *
 * @param rows - One row per file (already filtered, sorted, capped).
 * @returns The full `# Memories` markdown section.
 */
export function formatMemoryTable(rows: readonly MemoryTableRow[]): string {
    const lines: string[] = [
        "# Memories",
        "",
        "Files matching your prompt including descriptions are listed below. Use `fs_read` if you want to read the full file; use `memory_search` to look up more memories on demand.",
        "",
        "| File | Score (1-100) | Description |",
        "| - | - | - |",
    ];
    for (const row of rows) {
        lines.push(`| \`${row.path}\` | ${row.scorePercent} | ${row.description} |`);
    }
    return lines.join("\n").trimEnd();
}

/**
 * Reduce a markdown-shaped string to a single line of plain text safe
 * to drop into a table cell: strip the common inline/structural markup,
 * collapse all whitespace to single spaces, escape pipes so they can't
 * break the row, and cap the length (appending `…` when truncated).
 *
 * @param raw - The source text (may contain markdown markup).
 * @returns Sanitized, length-capped plain text. Empty string in, empty
 *   string out.
 */
export function sanitizeDescription(raw: string): string {
    let text = raw
        // Images / links: keep the visible text, drop the target.
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        // Inline code, emphasis, strikethrough markers.
        .replace(/[`*_~]/g, "")
        // Leading heading hashes and blockquote markers per line.
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
        .replace(/^[ \t]*>[ \t]?/gm, "");
    // Collapse every run of whitespace (incl. newlines) to one space.
    text = text.replace(/\s+/g, " ").trim();
    // Escape pipes last so the table row stays well-formed.
    text = text.replace(/\|/g, "\\|");
    if (text.length > MAX_DESCRIPTION_LENGTH) {
        return `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
    }
    return text;
}

/**
 * Flat "every hit with score" renderer for the explicit-search
 * surfaces (the `memory_search` agent tool and the `./cli.sh memory
 * search` CLI). The user/agent asked for a specific query — the
 * caller wants to see what matched, not be silently filtered by a
 * threshold tuned for a different surface (system-prompt injection).
 *
 * Hits arrive already sorted by score (Orama's order). We group by
 * file to keep related chunks together but otherwise show everything,
 * with the per-chunk score visible so the reader can judge.
 */
export function formatHitsFlat(hits: readonly MemoryHit[]): string {
    if (hits.length === 0) {
        return "# Memory search\n\n(no hits)";
    }
    // Preserve Orama's score-descending order at the file level by
    // remembering each file's first-seen index.
    const order: string[] = [];
    const buckets = new Map<string, MemoryHit[]>();
    for (const hit of hits) {
        let bucket = buckets.get(hit.relativePath);
        if (!bucket) {
            bucket = [];
            buckets.set(hit.relativePath, bucket);
            order.push(hit.relativePath);
        }
        bucket.push(hit);
    }

    const lines: string[] = [
        `# Memory search — ${hits.length} hit${hits.length === 1 ? "" : "s"}`,
        "",
    ];
    for (const filePath of order) {
        lines.push(`## \`${filePath}\``);
        lines.push("");
        for (const hit of buckets.get(filePath) ?? []) {
            lines.push(`### ${hit.headlines} (score ${hit.score.toFixed(3)})`);
            lines.push("");
            const snippet = hit.snippet.trim();
            if (snippet.length > 0) {
                lines.push(snippet);
                lines.push("");
            }
        }
    }
    return lines.join("\n").trimEnd();
}
