import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HostContext, Logger } from "@getfamiliar/shared";
import { markdownTable, writeMarkdown } from "@getfamiliar/shared";
import { type CommandDef, defineCommand } from "citty";
import { DEFAULT_FILE_READ_RETENTION_DAYS, readMemoryConfig } from "./Config.js";
import { type AgentEvalResult, runAgentEval } from "./EvalAgent.js";
import { defaultEvalDir, EVAL_LANGUAGES, type EvalLanguage } from "./EvalCases.js";
import { buildEvalModel } from "./EvalModel.js";
import { renderEvalReport } from "./EvalReport.js";
import { DEFAULT_EVAL_SETTINGS, type MemoryEvalResult, runMemoryEval } from "./EvalRunner.js";
import { renderCategoryList, renderDateHits, renderFileHits } from "./SearchRender.js";
import { parseDateSearchArgs } from "./Tools.js";
import { DedupPairStore } from "./WikiDedup.js";
import { DreamStore } from "./WikiDream.js";
import { LIVE_INDEX_SCHEMA, WikiIndex } from "./WikiIndex.js";
import {
    type DateFix,
    type DedupPassSummary,
    type DreamPassDeps,
    type DreamPassSummary,
    describeRun,
    emitReviews,
    type HandOverSummary,
    type LintedFile,
    lintWiki,
    listDueReviews,
    type PassDeps,
    planDreams,
    runDedupPass,
    runDreamPass,
    runLintPass,
    runSplitPass,
    type SplitPassSummary,
} from "./WikiMaintenance.js";
import { listCategories, searchDates, searchFiles } from "./WikiSearch.js";
import { findOversizedFiles } from "./WikiSplit.js";

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
        lintCommand(ctx),
        reviewsCommand(ctx),
        splitCommand(ctx),
        dedupCommand(ctx),
        dreamCommand(ctx),
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

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function lintCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "lint",
            description:
                "Check every wiki file for broken frontmatter and non-ISO dates. Without --fix it only reports.",
        },
        args: {
            fix: {
                type: "boolean",
                required: false,
                description:
                    "Do what the nightly lint job does: rewrite unambiguous dates to ISO (one git commit) and hand the remaining problems to skills:memory:repair runs (needs the daemon).",
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            const { fixes, flagged } = await lintWiki(ctx.workspaceDir);
            const parts = [renderDateFixes(fixes), renderFlagged(flagged)];
            if (args.fix === true) {
                const { applied, handOver } = await runLintPass(
                    ctx.workspaceDir,
                    (event) => ctx.events.emit(event),
                    (paths, message) => ctx.workspaceHistory.commitFiles(paths, message),
                    warningsOnlyLogger(ctx.logger),
                );
                parts.push(
                    `Rewrote ${applied.dates} date(s) in ${applied.files.length} file(s)${applied.commitId ? ` (commit \`${applied.commitId}\`)` : " (no commit: no workspace history)"}${applied.skipped.length > 0 ? `; skipped ${applied.skipped.length} file(s) that changed meanwhile` : ""}.`,
                    renderHandOver(handOver, "skills:memory:repair"),
                );
            }
            writeMarkdown(`${parts.join("\n\n")}\n`, { raw: args.raw === true });
        },
    });
}

/**
 * Renders the dates the linter rewrites by itself, one row per file.
 *
 * @param fixes - From `lintWiki`.
 * @returns Markdown.
 */
function renderDateFixes(fixes: readonly DateFix[]): string {
    if (fixes.length === 0) {
        return "No dates to rewrite.";
    }
    const total = fixes.reduce((sum, fix) => sum + fix.replacements.length, 0);
    const rows = fixes.map((fix) => {
        const examples = fix.replacements
            .slice(0, 2)
            .map((replacement) => `${replacement.from} → ${replacement.to}`)
            .join(", ");
        return [fix.path, String(fix.replacements.length), examples];
    });
    return `${total} date(s) in ${fixes.length} file(s) are rewritten to ISO automatically:\n\n${markdownTable(["File", "Dates", "Examples"], rows)}`;
}

/**
 * Renders the problems left for the repair handler.
 *
 * @param flagged - From `lintWiki`.
 * @returns Markdown.
 */
function renderFlagged(flagged: readonly LintedFile[]): string {
    const rows = flagged.flatMap((file) =>
        file.problems.map((problem) => [
            file.path,
            String(problem.lineNo),
            problem.rule,
            problem.message,
        ]),
    );
    if (rows.length === 0) {
        return "Nothing left for the repair handler.";
    }
    return `${rows.length} problem(s) in ${flagged.length} file(s) need the repair handler (\`skills:memory:repair\`):\n\n${markdownTable(["File", "Line", "Rule", "Problem"], rows)}`;
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function reviewsCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "reviews",
            description:
                "List the wiki files whose review_at is due (today in core.timezone or earlier), like the daily review job.",
        },
        args: {
            run: {
                type: "boolean",
                required: false,
                description:
                    "Hand every due file to a skills:memory:review run now (needs the daemon).",
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            const index = await openLiveIndex(ctx);
            const due = await listDueReviews(
                index,
                ctx.config.getString("core.timezone", "UTC") ?? "UTC",
            );
            const parts = [
                due.length === 0
                    ? "No file is due for review."
                    : markdownTable(
                          ["File", "review_at"],
                          due.map((review) => [review.path, review.reviewAt]),
                      ),
            ];
            if (args.run === true && due.length > 0) {
                const summary = await emitReviews(
                    due,
                    (event) => ctx.events.emit(event),
                    warningsOnlyLogger(ctx.logger),
                );
                parts.push(renderHandOver(summary, "skills:memory:review"));
            }
            writeMarkdown(`${parts.join("\n\n")}\n`, { raw: args.raw === true });
        },
    });
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function splitCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "split",
            description:
                "List the wiki files larger than memory.maxFileBytes, which the daily split job hands to skills:memory:split.",
        },
        args: {
            run: {
                type: "boolean",
                required: false,
                description:
                    "Run the split pass now and wait for it: one split run per file after the other, harness cut for files still too big, wiki/ committed before and after (needs the daemon).",
            },
            n: {
                type: "string",
                required: false,
                description: "With --run: start at most this many skills:memory:split runs.",
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            const { maxFileBytes } = readMemoryConfig(ctx.config);
            const oversized = await findOversizedFiles(ctx.workspaceDir, maxFileBytes);
            const parts = [
                oversized.length === 0
                    ? `No wiki file is larger than ${maxFileBytes} bytes.`
                    : `${oversized.length} file(s) larger than ${maxFileBytes} bytes:\n\n${markdownTable(
                          ["File", "Bytes"],
                          oversized.map((file) => [file.path, String(file.bytes)]),
                      )}`,
            ];
            if (args.run === true && oversized.length > 0) {
                const summary = await runSplitPass(await buildPassDeps(ctx, maxRunsArg(args.n)));
                parts.push(renderSplitSummary(summary));
            }
            writeMarkdown(`${parts.join("\n\n")}\n`, { raw: args.raw === true });
        },
    });
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function dedupCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "dedup",
            description:
                "List the file pairs earlier deduplicate runs handled (they get no new run until a file is gone or changed by 20 %, at least 500 bytes).",
        },
        args: {
            run: {
                type: "boolean",
                required: false,
                description:
                    "Run the dedup pass now and wait for it: one dedup-scan per wiki folder, then one deduplicate run per new candidate group, wiki/ committed before and after (needs the daemon).",
            },
            n: {
                type: "string",
                required: false,
                description:
                    "With --run: start at most this many skills:memory:deduplicate (the folder scans always run) runs.",
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            const index = await openLiveIndex(ctx);
            const pairs = await new DedupPairStore(index).list();
            const parts = [
                pairs.length === 0
                    ? "No file pair has been handled yet."
                    : `${pairs.length} handled pair(s):\n\n${markdownTable(
                          ["File A", "Bytes", "File B", "Bytes"],
                          pairs.map((pair) => [
                              pair.pathA,
                              String(pair.sizeA),
                              pair.pathB,
                              String(pair.sizeB),
                          ]),
                      )}`,
            ];
            if (args.run === true) {
                const summary = await runDedupPass(
                    await buildPassDeps(ctx, maxRunsArg(args.n), index),
                );
                parts.push(renderDedupSummary(summary));
            }
            writeMarkdown(`${parts.join("\n\n")}\n`, { raw: args.raw === true });
        },
    });
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function dreamCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "dream",
            description:
                "Show which wiki files the next dream pass would pick (changed, hot, cold, oldest, random) and which are locked because they were dreamed recently.",
        },
        args: {
            run: {
                type: "boolean",
                required: false,
                description:
                    "Run the dream pass now and wait for it: one skills:memory:dream run per picked file after the other, wiki/ committed before and after (needs the daemon).",
            },
            n: {
                type: "string",
                required: false,
                description: "With --run: start at most this many skills:memory:dream runs.",
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            const index = await openLiveIndex(ctx);
            const deps = await buildDreamPassDeps(ctx, maxRunsArg(args.n), index);
            const { selections, locked } = await planDreams(deps);
            const parts = [
                selections.length === 0
                    ? "The next dream pass would pick no file."
                    : `The next dream pass would pick ${selections.length} file(s):\n\n${markdownTable(
                          ["File", "Criterion", "Reason"],
                          selections.map((selection) => [
                              selection.path,
                              selection.criterion,
                              selection.reason,
                          ]),
                      )}`,
            ];
            const recent = await new DreamStore(index).listDreamsSince(
                new Date(Date.now() - deps.dream.lockDays * 24 * 60 * 60 * 1000),
            );
            parts.push(
                recent.length === 0
                    ? `No file is locked (nothing dreamed in the last ${deps.dream.lockDays} days).`
                    : `${locked.length} file(s) locked, dreamed in the last ${deps.dream.lockDays} days:\n\n${markdownTable(
                          ["Dreamed", "File", "Criterion", "Event", "Summary"],
                          recent.map((dream) => [
                              dream.dreamedAt.toISOString().slice(0, 16).replace("T", " "),
                              dream.path,
                              dream.criterion,
                              dream.eventId ?? "",
                              dream.summary.split("\n")[0] ?? "",
                          ]),
                      )}`,
            );
            if (args.run === true && selections.length > 0) {
                parts.push(renderDreamSummary(await runDreamPass(deps)));
            }
            writeMarkdown(`${parts.join("\n\n")}\n`, { raw: args.raw === true });
        },
    });
}

/**
 * The dependencies of a dream pass run from the CLI.
 *
 * @param ctx - Host context.
 * @param maxRuns - Most dream runs to start (`-n`), `undefined` for all.
 * @param index - The live index.
 * @returns The deps.
 */
async function buildDreamPassDeps(
    ctx: HostContext,
    maxRuns: number | undefined,
    index: WikiIndex,
): Promise<DreamPassDeps> {
    return {
        ...(await buildPassDeps(ctx, maxRuns, index)),
        dream: readMemoryConfig(ctx.config).dream,
        summarizeReads: (options) => ctx.workspaceReads.summarize(options),
        readWindowDays: ctx.config.getNumber(
            "core.fileReadRetentionDays",
            DEFAULT_FILE_READ_RETENTION_DAYS,
        ),
    };
}

/**
 * Renders a dream pass for the CLI.
 *
 * @param summary - The pass.
 * @returns Markdown.
 */
function renderDreamSummary(summary: DreamPassSummary): string {
    const rows = summary.outcomes.map((outcome) => [
        outcome.selection.path,
        outcome.selection.criterion,
        outcome.bytesBefore === undefined ? "gone" : String(outcome.bytesBefore),
        outcome.bytesAfter === undefined ? "gone" : String(outcome.bytesAfter),
        outcome.run !== undefined && "eventId" in outcome.run ? (outcome.run.eventId ?? "") : "",
        describeRun(outcome.run),
    ]);
    return `Dream pass${renderCommits(summary.snapshotCommitId, summary.finalCommitId)}:\n\n${markdownTable(["File", "Criterion", "Before", "After", "Event", "Summary"], rows)}`;
}

/**
 * The dependencies of a split or dedup pass run from the CLI. Progress goes to the logger, since
 * a pass waits for every run and can take a long time.
 *
 * @param ctx - Host context.
 * @param maxRuns - Most handler runs to start (`-n`), `undefined` for all.
 * @param index - The live index, opened when omitted.
 * @returns The deps.
 */
async function buildPassDeps(
    ctx: HostContext,
    maxRuns: number | undefined,
    index?: WikiIndex,
): Promise<PassDeps> {
    return {
        workspaceDir: ctx.workspaceDir,
        index: index ?? (await openLiveIndex(ctx)),
        emit: (event) => ctx.events.emit(event),
        commitDirectory: (dir, message) => ctx.workspaceHistory.commitDirectory(dir, message),
        log: ctx.logger,
        maxFileBytes: readMemoryConfig(ctx.config).maxFileBytes,
        timezone: ctx.config.getString("core.timezone", "UTC") ?? "UTC",
        shouldStop: () => false,
        maxRuns,
    };
}

/**
 * Parses the `-n` flag.
 *
 * @param raw - Flag value.
 * @returns The limit, `undefined` when not given.
 * @throws {Error} When it is no positive integer.
 */
function maxRunsArg(raw: unknown): number | undefined {
    return raw === undefined ? undefined : parsePositiveInteger(raw, "-n");
}

/**
 * Renders a split pass for the CLI.
 *
 * @param summary - The pass.
 * @returns Markdown.
 */
function renderSplitSummary(summary: SplitPassSummary): string {
    const rows = summary.outcomes.map((outcome) => [
        outcome.path,
        String(outcome.bytesBefore),
        outcome.bytesAfter === undefined ? "gone" : String(outcome.bytesAfter),
        describeRun(outcome.run),
        outcome.harnessSecondPath ?? "",
    ]);
    return `Split pass${renderCommits(summary.snapshotCommitId, summary.finalCommitId)}:\n\n${markdownTable(["File", "Before", "After", "Run", "Harness cut"], rows)}`;
}

/**
 * Renders a dedup pass for the CLI.
 *
 * @param summary - The pass.
 * @returns Markdown.
 */
function renderDedupSummary(summary: DedupPassSummary): string {
    const scans = summary.scans
        .map((scan) => `${scan.folder}: ${describeRun(scan.run)}`)
        .join("; ");
    const head = `Dedup pass${renderCommits(summary.snapshotCommitId, summary.finalCommitId)}: ${summary.prunedPairs} stale pair(s) forgotten; scans — ${scans || "none"}; ${summary.reportedGroups} group(s) reported, ${summary.knownGroups} handled before.`;
    if (summary.outcomes.length === 0) {
        return head;
    }
    const rows = summary.outcomes.map((outcome) => [
        outcome.group.join(", "),
        describeRun(outcome.run),
        String(outcome.recordedPairs),
    ]);
    return `${head}\n\n${markdownTable(["Group", "Run", "Pairs stored"], rows)}`;
}

/**
 * Renders the commit ids of a pass.
 *
 * @param snapshotCommitId - Commit before.
 * @param finalCommitId - Commit after.
 * @returns ` (commits a → b)` or an empty string.
 */
function renderCommits(snapshotCommitId: string | null, finalCommitId: string | null): string {
    if (snapshotCommitId === null && finalCommitId === null) {
        return "";
    }
    return ` (commits \`${snapshotCommitId ?? "–"}\` → \`${finalCommitId ?? "–"}\`)`;
}

/**
 * Renders what a hand-over did, for the CLI.
 *
 * @param summary - The counts.
 * @param topic - The handler topic.
 * @returns One line of markdown.
 */
function renderHandOver(summary: HandOverSummary, topic: string): string {
    return `Handed ${summary.emitted} file(s) to \`${topic}\`; ${summary.earlier} already handed over earlier for the same content, ${summary.failed} failed.`;
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
