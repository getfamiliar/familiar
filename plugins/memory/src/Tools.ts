import { createHash } from "node:crypto";
import {
    EVENT_PRIORITY,
    type HostContext,
    type PluginTool,
    runTextTool,
    ToolError,
} from "@getfamiliar/shared";
import { readMemoryConfig } from "./Config.js";
import { renderDateHits, renderFileHits } from "./SearchRender.js";
import type { WikiIndex } from "./WikiIndex.js";
import {
    type DateQuery,
    MAX_SEARCH_TERMS,
    prepareTerms,
    searchDates,
    searchFiles,
    validateDateQuery,
} from "./WikiSearch.js";

/**
 * The save handler's event topic, emitted as an exact topic so it
 * resolves to `workspace/skills/memory/save.md` and nothing else (the
 * topic is the handler's address: `:` segments become folders). The
 * skill explainer at `skills/memory/SKILL.md` lives alongside the
 * handler so both ship together in the plugin's `workspace-template/`.
 */
export const SAVE_TOPIC = "skills:memory:save";

/** Topic of the run that repairs one wiki file the linter flagged (`skills/memory/repair.md`). */
export const REPAIR_TOPIC = "skills:memory:repair";

/** Topic of the run that reviews one wiki file whose `review_at` is due (`skills/memory/review.md`). */
export const REVIEW_TOPIC = "skills:memory:review";

/** Topic of the split handler (`skills/memory/split.md`): one oversized wiki file. */
export const SPLIT_TOPIC = "skills:memory:split";

/** Topic of the dedup scan (`skills/memory/dedup-scan.md`): one wiki folder's file list. */
export const DEDUP_SCAN_TOPIC = "skills:memory:dedup-scan";

/** Topic of the deduplicate handler (`skills/memory/deduplicate.md`): one candidate group. */
export const DEDUPLICATE_TOPIC = "skills:memory:deduplicate";

/** Description of `memory_search`; also what the eval's LLM stage shows the model. */
export const SEARCH_TOOL_DESCRIPTION = `Search the long-term memory (every markdown file under \`wiki/\`) for files matching ANY of 1–${MAX_SEARCH_TERMS} terms. Returns a markdown table: path, title, one-line description, categories, which of your terms matched, and the best matching line. Files matching more of your terms come first.

How to search well — the search is literal, not semantic, so YOU do the thinking:
- Send names exactly as written (\`Tobias Hartl\`), typos are tolerated within about one letter.
- Add synonyms, related words and the other language yourself: \`["Steuerberater", "Steuerberatung", "tax advisor"]\`.
- Use the memory categories from the prompt as terms (\`"versicherung"\`) to find files by topic.
- Prefer several short terms over one long phrase; whole sentences match nothing.
- No result means the memory knows nothing under those words — try other words once, then say so.

Judge the result yourself: \`Matched\` shows how many of your terms a file contains. A file that only shares a generic word (a first name, "Termin", "invoice") or another topic's word is not about your subject. If no file is actually about it, the memory does not know it — say so instead of citing loosely related files.
Read a found file with \`fs_read\` before relying on it. For dates use \`memory_datesearch\`.`;

/** Description of `memory_datesearch`; also what the eval's LLM stage shows the model. */
export const DATE_SEARCH_TOOL_DESCRIPTION = `List every line in the long-term memory (\`wiki/\`) that mentions an ISO date in a range, or on a given day of the year. Returns a markdown table: date, path, the line itself, ordered by date. Month entries (\`2026-07\`) count for every day of that month.

Give either \`from\` + \`to\` (ISO dates, inclusive; one day: from = to) or \`day\` (\`MM-DD\`, e.g. \`07-12\` for every July 12th in any year — birthdays, anniversaries). Convert natural dates yourself ("25. Mai 2026" → from/to \`2026-05-25\`, "Mai 2026" → \`2026-05-01\`…\`2026-05-31\`).`;

/** Arguments of `memory_search`. */
interface SearchArgs {
    readonly terms: readonly string[];
}

/** Arguments of `memory_datesearch`. */
interface DateSearchArgs {
    readonly from?: string;
    readonly to?: string;
    readonly day?: string;
}

/** JSON schema of `memory_search`. */
export const SEARCH_TOOL_SCHEMA = {
    type: "object",
    required: ["terms"],
    additionalProperties: false,
    properties: {
        terms: {
            type: "array",
            minItems: 1,
            maxItems: MAX_SEARCH_TERMS,
            items: { type: "string" },
            description: `1–${MAX_SEARCH_TERMS} search terms, OR-combined, e.g. ["Alte Mühle", "Hausverkauf", "Makler"].`,
        },
    },
} as const;

/** JSON schema of `memory_datesearch`. */
export const DATE_SEARCH_TOOL_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        from: {
            type: "string",
            description: "First day, ISO YYYY-MM-DD, e.g. 2026-05-01. Requires `to`.",
        },
        to: {
            type: "string",
            description: "Last day (inclusive), ISO YYYY-MM-DD, e.g. 2026-05-31. Requires `from`.",
        },
        day: {
            type: "string",
            description: "Day of the year MM-DD in any year, e.g. 07-12. Instead of from/to.",
        },
    },
} as const;

/**
 * Turns the raw tool arguments into a date query.
 *
 * @param args - The arguments.
 * @returns The validated query.
 * @throws {ToolError} `InvalidArgument` when neither or both forms are given or a value is invalid.
 */
export function parseDateSearchArgs(args: DateSearchArgs): DateQuery {
    const from = args.from?.trim();
    const to = args.to?.trim();
    const day = args.day?.trim();
    const hasRange = Boolean(from) || Boolean(to);
    if (day && hasRange) {
        throw new ToolError(
            "InvalidArgument",
            "memory_datesearch: give either day or from/to, not both",
        );
    }
    let query: DateQuery;
    if (day) {
        query = { day };
    } else if (from && to) {
        query = { from, to };
    } else {
        throw new ToolError(
            "InvalidArgument",
            "memory_datesearch: give from and to (YYYY-MM-DD) or day (MM-DD)",
        );
    }
    try {
        validateDateQuery(query);
    } catch (err) {
        throw new ToolError("InvalidArgument", err instanceof Error ? err.message : String(err));
    }
    return query;
}

/**
 * Builds the memory tools the agent sees as `memory_search`, `memory_datesearch` and
 * `memory_save`.
 *
 * @param ctx - The plugin's host context (config is read per call).
 * @param getIndex - Returns the live index, or `undefined` when it could not be opened.
 * @returns The tools.
 */
export function buildMemoryTools(
    ctx: HostContext,
    getIndex: () => WikiIndex | undefined,
): readonly PluginTool[] {
    const requireIndex = (): WikiIndex => {
        const index = getIndex();
        if (!index) {
            throw new ToolError(
                "MemoryUnavailable",
                "The memory index is not available: the memory plugin could not open its postgres tables at startup (see the daemon log).",
            );
        }
        return index;
    };

    const searchTool: PluginTool<SearchArgs, string> = {
        name: "search",
        // Long-term memory is ambient: every handler benefits from recall, so both search tools
        // ride the implicit `core` tool set.
        groups: ["core"],
        description: SEARCH_TOOL_DESCRIPTION,
        inputSchema: SEARCH_TOOL_SCHEMA,
        execute: (args, callCtx) =>
            runTextTool(async () => {
                const terms = Array.isArray(args.terms)
                    ? args.terms.filter((term) => typeof term === "string")
                    : [];
                try {
                    prepareTerms(terms);
                } catch (err) {
                    throw new ToolError(
                        "InvalidArgument",
                        err instanceof Error ? err.message : String(err),
                    );
                }
                const config = readMemoryConfig(ctx.config);
                const hits = await searchFiles(requireIndex(), terms, {
                    limit: config.searchLimit,
                    similarityThreshold: config.similarityThreshold,
                });
                return renderFileHits(hits, terms);
            }, callCtx.toolRunContext),
    };

    const dateSearchTool: PluginTool<DateSearchArgs, string> = {
        name: "datesearch",
        groups: ["core"],
        description: DATE_SEARCH_TOOL_DESCRIPTION,
        inputSchema: DATE_SEARCH_TOOL_SCHEMA,
        execute: (args, callCtx) =>
            runTextTool(async () => {
                const query = parseDateSearchArgs(args);
                return renderDateHits(await searchDates(requireIndex(), query), query);
            }, callCtx.toolRunContext),
    };

    const saveTool: PluginTool<{ content: string }, string> = {
        name: "save",
        groups: ["core"],
        description:
            "Save facts, observations, notes into long-term memory. Content is handed to a dedicated reasoning agentrun, this toolcall does not wait and returns immediately. Remember to include identifying facts in the content (email addresses, names etc.). Save facts about the world that will still matter in three months — not a protocol of your processing.",
        inputSchema: {
            type: "object",
            required: ["content"],
            properties: {
                content: {
                    type: "string",
                    minLength: 4,
                    description: "The information to remember, as freeform text.",
                },
            },
            additionalProperties: false,
        },
        execute: async ({ content }, toolCtx) => {
            const trimmed = content.trim();
            if (trimmed.length < 4) {
                throw new Error("memory_save: content too short (min 4 chars after trimming)");
            }
            // Content-hashed idempotency key dedups repeated saves of
            // the same text within the bus's dedup window.
            const idempotencyKey = `memory-save-${createHash("sha256")
                .update(trimmed)
                .digest("hex")
                .slice(0, 16)}`;
            const handle = await toolCtx.host.events.emit({
                topic: SAVE_TOPIC,
                isExactTopic: true,
                prompt: trimmed,
                payload: {
                    sourceEventId: toolCtx.event.id,
                    sourceAgentrunId: toolCtx.agentrun.id,
                },
                priority: EVENT_PRIORITY.BACKGROUND,
                idempotencyKey,
            });
            // Fire-and-forget: never await `settled` from inside the
            // tool call, but attach a no-op catch so a failed save
            // doesn't crash the daemon with an unhandled rejection.
            handle.settled.catch((err) => {
                toolCtx.log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    `memory: save event ${handle.id} settled with failure`,
                );
            });
            return `Queued (event ${handle.id}). The memory will be filed shortly.`;
        },
    };

    return [searchTool, dateSearchTool, saveTool];
}
