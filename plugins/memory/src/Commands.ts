import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HostContext, Logger } from "@getfamiliar/shared";
import { markdownTable, writeMarkdown } from "@getfamiliar/shared";
import { type CommandDef, defineCommand } from "citty";
import { readMemoryConfig } from "./Config.js";
import { type AgentEvalResult, runAgentEval } from "./EvalAgent.js";
import { defaultEvalDir, EVAL_LANGUAGES, type EvalLanguage } from "./EvalCases.js";
import { buildEvalModel } from "./EvalModel.js";
import { renderEvalReport } from "./EvalReport.js";
import { DEFAULT_EVAL_SETTINGS, type MemoryEvalResult, runMemoryEval } from "./EvalRunner.js";
import { renderCategoryList, renderDateHits, renderFileHits } from "./SearchRender.js";
import { parseDateSearchArgs } from "./Tools.js";
import { LIVE_INDEX_SCHEMA, WikiIndex } from "./WikiIndex.js";
import { listCategories, searchDates, searchFiles } from "./WikiSearch.js";

/**
 * CLI subcommands of the memory plugin. They work on the live index in postgres (schema
 * `memory`) and need the `familiar-postgres` container to be running (`familiar start`); the
 * daemon keeps that index in sync with `wiki/`, `memory reindex` re-syncs it by hand.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
export function buildMemoryCommands(ctx: HostContext): readonly CommandDef<any>[] {
    return [
        searchCommand(ctx),
        datesCommand(ctx),
        showCommand(ctx),
        categoriesCommand(ctx),
        reindexCommand(ctx),
        evalCommand(ctx),
    ];
}

/** `--raw` flag shared by every command. */
const RAW_ARG = {
    type: "boolean",
    required: false,
    description: "Print raw markdown even on a TTY.",
} as const;

/**
 * Opens the live index on `ctx.database`.
 *
 * @param ctx - Host context.
 * @returns The index (schema ensured).
 * @throws {Error} With a hint to start the daemon when postgres is unreachable.
 */
async function openLiveIndex(ctx: HostContext): Promise<WikiIndex> {
    const index = new WikiIndex(ctx.database, LIVE_INDEX_SCHEMA, warningsOnlyLogger(ctx.logger));
    try {
        await index.ensureSchema();
    } catch (err) {
        throw new Error(
            `memory: cannot reach postgres (${err instanceof Error ? err.message : String(err)}) — start it with \`familiar start\` first`,
        );
    }
    return index;
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function searchCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "search",
            description:
                "Search the wiki like the agent's memory_search: files matching any of the terms (quote multi-word terms).",
        },
        args: {
            terms: { type: "positional", required: true, description: "1–8 search terms." },
            limit: {
                type: "string",
                required: false,
                description: "Max files (default memory.searchLimit).",
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            const terms = (args._ as string[]).filter((term) => term.trim().length > 0);
            const config = readMemoryConfig(ctx.config);
            const index = await openLiveIndex(ctx);
            const hits = await searchFiles(index, terms, {
                limit: args.limit
                    ? parsePositiveInteger(args.limit, "--limit")
                    : config.searchLimit,
                similarityThreshold: config.similarityThreshold,
            });
            writeMarkdown(`${renderFileHits(hits, terms)}\n`, { raw: args.raw === true });
        },
    });
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function datesCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "dates",
            description:
                "List wiki lines with a date in a range (--from/--to) or on a day of the year (--day MM-DD), like memory_datesearch.",
        },
        args: {
            from: { type: "string", required: false, description: "First day, YYYY-MM-DD." },
            to: { type: "string", required: false, description: "Last day, YYYY-MM-DD." },
            day: { type: "string", required: false, description: "Day of the year, MM-DD." },
            raw: RAW_ARG,
        },
        async run({ args }) {
            const query = parseDateSearchArgs({
                from: optionalString(args.from),
                to: optionalString(args.to),
                day: optionalString(args.day),
            });
            const index = await openLiveIndex(ctx);
            writeMarkdown(`${renderDateHits(await searchDates(index, query), query)}\n`, {
                raw: args.raw === true,
            });
        },
    });
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function showCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "show",
            description:
                "Show what the index stores for one wiki file (title, description, categories, dates).",
        },
        args: {
            path: {
                type: "positional",
                required: true,
                description: "Workspace-relative path, e.g. wiki/people/alice.md.",
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            const index = await openLiveIndex(ctx);
            const relativePath = String(args.path);
            const files = await index.db.query<{
                title: string;
                description: string;
                categories: string[];
                review_at: string | null;
                last_touched: string;
                lines: string;
            }>(
                `SELECT title, description, categories, to_char(review_at, 'YYYY-MM-DD') AS review_at,
                        to_char(last_touched, 'YYYY-MM-DD') AS last_touched,
                        (SELECT count(*) FROM ${index.schema}.lines l WHERE l.path = f.path) AS lines
                 FROM ${index.schema}.files f WHERE path = $1`,
                [relativePath],
            );
            const file = files[0];
            if (!file) {
                writeMarkdown(`\`${relativePath}\` is not in the index.\n`, {
                    raw: args.raw === true,
                });
                return;
            }
            const dates = await index.db.query<{
                line_no: number;
                date_from: string;
                date_to: string;
                snippet: string;
            }>(
                `SELECT line_no, to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to, snippet
                 FROM ${index.schema}.dates WHERE path = $1 ORDER BY line_no, date_from`,
                [relativePath],
            );
            const lines = [
                `# ${file.title}`,
                "",
                `- Path: \`${relativePath}\``,
                `- Description: ${file.description || "(none)"}`,
                `- Categories: ${file.categories.join(", ") || "(none)"}`,
                `- review_at: ${file.review_at ?? "—"}`,
                `- Last touched: ${file.last_touched}`,
                `- Indexed lines: ${file.lines}`,
                "",
                "## Dates",
                "",
                dates.length === 0
                    ? "(none)"
                    : markdownTable(
                          ["Line", "From", "To", "Text"],
                          dates.map((row) => [
                              String(row.line_no),
                              row.date_from,
                              row.date_to,
                              row.snippet,
                          ]),
                      ),
            ];
            writeMarkdown(`${lines.join("\n")}\n`, { raw: args.raw === true });
        },
    });
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function categoriesCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "categories",
            description: "List the categories in use, as {MEMORY_CATEGORIES} renders them.",
        },
        args: { raw: RAW_ARG },
        async run({ args }) {
            const index = await openLiveIndex(ctx);
            writeMarkdown(`${renderCategoryList(await listCategories(index))}\n`, {
                raw: args.raw === true,
            });
        },
    });
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function reindexCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "reindex",
            description:
                "Sync the live index with wiki/ now (--full drops it first and rebuilds everything).",
        },
        args: {
            full: {
                type: "boolean",
                required: false,
                description: "Drop the index and rebuild it from scratch.",
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            let index = await openLiveIndex(ctx);
            if (args.full === true) {
                await index.dropSchema();
                index = await openLiveIndex(ctx);
            }
            const summary = await index.syncAll(ctx.workspaceDir);
            writeMarkdown(
                `Wiki index synced: ${summary.written} written, ${summary.unchanged} unchanged, ${summary.removed} removed (${await index.countFiles()} files indexed).\n`,
                { raw: args.raw === true },
            );
        },
    });
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function evalCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "eval",
            description:
                "Run the memory search eval set (plugins/memory/eval/) against throwaway postgres schemas and report recall, hit@1 and MRR.",
        },
        args: {
            lang: {
                type: "string",
                required: false,
                description:
                    "Corpus language: de, en or all (default all; all adds the en→de cross-language run).",
            },
            category: {
                type: "string",
                required: false,
                description: "Comma-separated categories to run (default all).",
            },
            case: {
                type: "string",
                required: false,
                description: "Comma-separated case id substrings to run (default all).",
            },
            threshold: {
                type: "string",
                required: false,
                description: `Word-similarity threshold (default ${DEFAULT_EVAL_SETTINGS.similarityThreshold}).`,
            },
            weights: {
                type: "string",
                required: false,
                description:
                    "Field weights as title,category,description,heading,body (default 4,3,3,2,1).",
            },
            agent: {
                type: "boolean",
                required: false,
                description:
                    "LLM stage: let a model formulate the searches from each case's prompt (costs model calls; replies are cached in tmp/memory-eval/agent-cache/).",
            },
            model: {
                type: "string",
                required: false,
                description:
                    "Model for --agent: an inference.aliases key or <provider>/<modelId> (default fast).",
            },
            reindex: {
                type: "boolean",
                required: false,
                description: "Drop and rebuild the eval schemas first.",
            },
            misses: {
                type: "boolean",
                required: false,
                description: "List every case with a must-have file missing from the top 5.",
            },
            json: {
                type: "string",
                required: false,
                description:
                    "Also write the full per-case results as JSON to this file (for diffing runs).",
            },
            dir: {
                type: "string",
                required: false,
                description: "Eval folder (default: the plugin's eval/ folder).",
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            const common = {
                evalDir: typeof args.dir === "string" ? path.resolve(args.dir) : defaultEvalDir(),
                languages: parseEvalLanguages(args.lang),
                categories: splitList(args.category),
                caseIdFilters: splitList(args.case),
                settings: {
                    similarityThreshold:
                        args.threshold === undefined
                            ? DEFAULT_EVAL_SETTINGS.similarityThreshold
                            : parseUnitInterval(args.threshold, "--threshold"),
                    weights:
                        args.weights === undefined
                            ? DEFAULT_EVAL_SETTINGS.weights
                            : parseWeights(args.weights),
                },
                isReindexForced: args.reindex === true,
                database: ctx.database,
                log: warningsOnlyLogger(ctx.logger),
                onProgress: (message: string) => process.stderr.write(`memory eval: ${message}\n`),
            };
            let result: MemoryEvalResult | AgentEvalResult;
            if (args.agent === true) {
                const model = await buildEvalModel(ctx, optionalString(args.model) ?? "fast");
                result = await runAgentEval({
                    ...common,
                    model: model.model,
                    modelLabel: model.label,
                    cacheDir: path.join(ctx.tmpDir, "memory-eval", "agent-cache"),
                });
            } else {
                result = await runMemoryEval(common);
            }
            if (typeof args.json === "string" && args.json.length > 0) {
                await fs.writeFile(args.json, `${JSON.stringify(result, null, 2)}\n`);
            }
            writeMarkdown(renderEvalReport(result, { isFailureListShown: args.misses === true }), {
                raw: args.raw === true,
            });
        },
    });
}

/**
 * Narrows a citty flag value to a string.
 *
 * @param raw - Flag value.
 * @returns The string, or `undefined` for anything else.
 */
function optionalString(raw: unknown): string | undefined {
    return typeof raw === "string" ? raw : undefined;
}

/**
 * Parses a positive integer flag.
 *
 * @param raw - Flag value.
 * @param flag - Flag name, for the message.
 * @returns The integer.
 * @throws {Error} When the value is not a positive integer.
 */
function parsePositiveInteger(raw: unknown, flag: string): number {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${flag} must be a positive integer, got ${String(raw)}`);
    }
    return value;
}

/**
 * Parses a number flag in (0, 1].
 *
 * @param raw - Flag value.
 * @param flag - Flag name, for the message.
 * @returns The number.
 * @throws {Error} When the value is out of range.
 */
function parseUnitInterval(raw: unknown, flag: string): number {
    const value = Number(raw);
    if (!(value > 0 && value <= 1)) {
        throw new Error(`${flag} must be a number in (0, 1], got ${String(raw)}`);
    }
    return value;
}

/**
 * Parses `--weights title,category,description,heading,body`.
 *
 * @param raw - Flag value.
 * @returns The field weights.
 * @throws {Error} When there aren't five non-negative numbers.
 */
function parseWeights(raw: unknown): (typeof DEFAULT_EVAL_SETTINGS)["weights"] {
    const values = String(raw).split(",").map(Number);
    if (values.length !== 5 || values.some((value) => !(value >= 0))) {
        throw new Error(
            `--weights must be five non-negative numbers (title,category,description,heading,body), got ${String(raw)}`,
        );
    }
    const [title, category, description, heading, body] = values;
    return { title, category, description, heading, body };
}

/**
 * Parses `--lang`.
 *
 * @param raw - Flag value.
 * @returns The selected corpus languages.
 * @throws {Error} When the value is not de, en or all.
 */
function parseEvalLanguages(raw: unknown): EvalLanguage[] {
    if (raw === undefined || raw === "all") {
        return [...EVAL_LANGUAGES];
    }
    if (raw === "de" || raw === "en") {
        return [raw];
    }
    throw new Error(`--lang must be de, en or all, got ${String(raw)}`);
}

/**
 * Splits a comma-separated flag.
 *
 * @param raw - Flag value.
 * @returns The non-empty trimmed entries (empty when the flag is absent).
 */
function splitList(raw: unknown): string[] {
    if (typeof raw !== "string") {
        return [];
    }
    return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/**
 * Wraps a logger so only warnings and errors get through, keeping CLI output clean.
 *
 * @param base - The logger to forward to.
 * @returns A logger that drops debug and info records.
 */
function warningsOnlyLogger(base: Logger): Logger {
    const drop = (): void => {};
    return {
        debug: drop,
        info: drop,
        warn: (objOrMessage: object | string, message?: string) =>
            typeof objOrMessage === "string"
                ? base.warn(objOrMessage)
                : base.warn(objOrMessage, message),
        error: (objOrMessage: object | string, message?: string) =>
            typeof objOrMessage === "string"
                ? base.error(objOrMessage)
                : base.error(objOrMessage, message),
        child: (bindings) => warningsOnlyLogger(base.child(bindings)),
    };
}
