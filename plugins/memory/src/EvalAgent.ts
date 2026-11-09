import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DatabaseApi, Logger } from "@getfamiliar/shared";
import { generateText, isStepCount, jsonSchema, type LanguageModel, tool } from "ai";
import { type EvalCase, type EvalLanguage, loadEvalCases } from "./EvalCases.js";
import { type RankedFile, scoreCase } from "./EvalMetrics.js";
import {
    type CaseRunResult,
    type CorpusIndexSummary,
    type EvalRunLabel,
    type EvalSearchSettings,
    type MemoryEvalResult,
    openCorpusIndex,
} from "./EvalRunner.js";
import { renderCategoryList, renderDateHits, renderFileHits } from "./SearchRender.js";
import {
    DATE_SEARCH_TOOL_DESCRIPTION,
    DATE_SEARCH_TOOL_SCHEMA,
    parseDateSearchArgs,
    SEARCH_TOOL_DESCRIPTION,
    SEARCH_TOOL_SCHEMA,
} from "./Tools.js";
import type { WikiIndex } from "./WikiIndex.js";
import {
    type DateQuery,
    DEFAULT_SEARCH_LIMIT,
    listCategories,
    prepareTerms,
    searchDates,
    searchFiles,
} from "./WikiSearch.js";

/**
 * The eval's LLM stage: a model gets each case's user prompt, the two search tools (same
 * descriptions and result tables as the agent) and the category list, searches up to
 * {@link MAX_TOOL_CALLS} times and names the relevant files. Measures whether the model formulates
 * terms good enough for the literal search.
 *
 * Model replies are cached by a hash over model, instructions, tool texts, categories and prompt;
 * a cached case replays its recorded tool calls against the index, so reruns cost nothing and a
 * changed index or ranking is still measured (the model's later calls are not re-decided, though).
 */

/** Most tool calls the model may make per case. */
const MAX_TOOL_CALLS = 3;

/** Cases in flight at once. */
const AGENT_CONCURRENCY = 4;

/** Files per search, as the live tool returns by default. */
const SEARCH_LIMIT = DEFAULT_SEARCH_LIMIT;

/** "Today" in the fictional world. */
const EVAL_TODAY = "2026-11-09";

/** Instructions for the model. */
const SYSTEM_PROMPT = `You are the memory lookup step of a personal assistant. A message for the user arrived (below). Find the files in the user's long-term memory (a markdown wiki) that the assistant needs to handle it: the people, places, projects and events it is about.

- Use memory_search and memory_datesearch, at most ${MAX_TOOL_CALLS} calls in total. The search is literal, so think about the words the wiki uses.
- The wiki may be written in another language than the message.
- Today is ${EVAL_TODAY}.

When done, reply with one final line: FILES: <path>, <path>, … (most relevant first). List only files that hold information about what the message is about; a file that merely shares a person, a word or a related topic does not count. Reply FILES: none if no file is about it.

Memory categories with file counts: {CATEGORIES}`;

/** One tool call the model made. */
export interface AgentToolCall {
    /** `memory_search` or `memory_datesearch`. */
    readonly tool: string;
    /** The arguments as sent. */
    readonly args: Record<string, unknown>;
}

/** What the model did for one case. */
export interface AgentTrace {
    /** Its tool calls, in order. */
    readonly calls: readonly AgentToolCall[];
    /** The paths of its `FILES:` line (empty for `none` or no such line). */
    readonly answer: readonly string[];
    /** Share of must-have files named in the answer; `null` for negative cases. */
    readonly answerRecall: number | null;
    /** Share of named files that have a grade; `null` for an empty answer. */
    readonly answerPrecision: number | null;
    /** Whether the reply came from the cache. */
    readonly isCached: boolean;
}

/** A case result with the model's trace. */
export interface AgentCaseRunResult extends CaseRunResult {
    readonly agent: AgentTrace;
}

/** Inputs of {@link runAgentEval}. */
export interface AgentEvalOptions {
    readonly evalDir: string;
    readonly languages: readonly EvalLanguage[];
    readonly categories: readonly string[];
    readonly caseIdFilters: readonly string[];
    readonly settings: EvalSearchSettings;
    readonly isReindexForced: boolean;
    readonly database: DatabaseApi;
    readonly log: Logger;
    readonly onProgress: (message: string) => void;
    /** The model to test. */
    readonly model: LanguageModel;
    /** Its label, part of the cache key and the report. */
    readonly modelLabel: string;
    /** Folder for cached replies. */
    readonly cacheDir: string;
}

/** Result of {@link runAgentEval}. */
export interface AgentEvalResult extends MemoryEvalResult {
    readonly modelLabel: string;
    readonly results: readonly AgentCaseRunResult[];
}

/** Cached model reply. */
interface CachedReply {
    readonly calls: readonly AgentToolCall[];
    readonly text: string;
}

/**
 * Indexes the corpora and runs every selected case through the model.
 *
 * @param opts - Inputs.
 * @returns The results with traces.
 * @throws {Error} When postgres or the model API fails.
 */
export async function runAgentEval(opts: AgentEvalOptions): Promise<AgentEvalResult> {
    const startedAt = new Date().toISOString();
    const caseSet = loadEvalCases(opts.evalDir);
    const cases = caseSet.cases.filter(
        (evalCase) =>
            (opts.categories.length === 0 || opts.categories.includes(evalCase.category)) &&
            (opts.caseIdFilters.length === 0 ||
                opts.caseIdFilters.some((filter) => evalCase.id.includes(filter))),
    );
    const isCrossRunSelected = opts.languages.includes("de") && opts.languages.includes("en");
    await fs.mkdir(opts.cacheDir, { recursive: true });

    const corpora: CorpusIndexSummary[] = [];
    const results: AgentCaseRunResult[] = [];
    for (const language of opts.languages) {
        opts.onProgress(`indexing corpus/${language}/wiki …`);
        const { index, summary } = await openCorpusIndex(language, opts);
        corpora.push(summary);
        const categories = renderCategoryList(await listCategories(index));
        const jobs: {
            evalCase: EvalCase;
            run: EvalRunLabel;
            prompt: string;
            grades: ReadonlyMap<string, number>;
        }[] = cases.map((evalCase) => ({
            evalCase,
            run: language,
            prompt: evalCase.query[language],
            grades: evalCase.relevant[language],
        }));
        if (language === "de" && isCrossRunSelected) {
            for (const evalCase of cases.filter((entry) => entry.crossLanguage)) {
                jobs.push({
                    evalCase,
                    run: "en→de",
                    prompt: evalCase.query.en,
                    grades: evalCase.relevant.de,
                });
            }
        }
        opts.onProgress(`corpus/${language}: asking ${opts.modelLabel} for ${jobs.length} cases`);
        let done = 0;
        let nextIndex = 0;
        const runResults: AgentCaseRunResult[] = new Array(jobs.length);
        const worker = async (): Promise<void> => {
            while (nextIndex < jobs.length) {
                const position = nextIndex++;
                const job = jobs[position];
                runResults[position] = await runAgentCase(index, categories, job, opts);
                done++;
                if (done % 20 === 0) {
                    opts.onProgress(`corpus/${language}: ${done}/${jobs.length} cases`);
                }
            }
        };
        await Promise.all(Array.from({ length: AGENT_CONCURRENCY }, () => worker()));
        results.push(...runResults);
    }
    return {
        modelLabel: opts.modelLabel,
        settings: opts.settings,
        startedAt,
        caseProblems: caseSet.problems,
        corpora,
        results,
    };
}

/**
 * Runs (or replays) one case.
 *
 * @param index - The corpus index.
 * @param categories - Rendered category list.
 * @param job - Case, run, prompt and grades.
 * @param opts - Eval inputs.
 * @returns The scored result with the trace.
 */
async function runAgentCase(
    index: WikiIndex,
    categories: string,
    job: {
        evalCase: EvalCase;
        run: EvalRunLabel;
        prompt: string;
        grades: ReadonlyMap<string, number>;
    },
    opts: AgentEvalOptions,
): Promise<AgentCaseRunResult> {
    const system = SYSTEM_PROMPT.replace("{CATEGORIES}", categories);
    const cacheKey = createHash("sha256")
        .update(
            JSON.stringify([
                opts.modelLabel,
                system,
                SEARCH_TOOL_DESCRIPTION,
                DATE_SEARCH_TOOL_DESCRIPTION,
                job.prompt,
            ]),
        )
        .digest("hex")
        .slice(0, 32);
    const cacheFile = path.join(opts.cacheDir, `${cacheKey}.json`);
    const seen: string[] = [];
    const execute = async (call: AgentToolCall): Promise<string> => {
        const output = await executeToolCall(index, call, opts.settings);
        for (const filePath of output.paths) {
            if (!seen.includes(filePath)) {
                seen.push(filePath);
            }
        }
        return output.text;
    };

    let reply = await readCachedReply(cacheFile);
    const isCached = reply !== undefined;
    if (reply) {
        for (const call of reply.calls) {
            await execute(call);
        }
    } else {
        const calls: AgentToolCall[] = [];
        const record =
            (toolName: string) =>
            async (args: Record<string, unknown>): Promise<string> => {
                if (calls.length >= MAX_TOOL_CALLS) {
                    return `Tool budget exhausted (${MAX_TOOL_CALLS} calls). Reply with the FILES line now.`;
                }
                const call = { tool: toolName, args };
                calls.push(call);
                return execute(call);
            };
        const result = await generateText({
            model: opts.model,
            system,
            prompt: job.prompt,
            tools: {
                memory_search: tool({
                    description: SEARCH_TOOL_DESCRIPTION,
                    inputSchema: jsonSchema<Record<string, unknown>>(SEARCH_TOOL_SCHEMA),
                    execute: record("memory_search"),
                }),
                memory_datesearch: tool({
                    description: DATE_SEARCH_TOOL_DESCRIPTION,
                    inputSchema: jsonSchema<Record<string, unknown>>(DATE_SEARCH_TOOL_SCHEMA),
                    execute: record("memory_datesearch"),
                }),
            },
            stopWhen: isStepCount(MAX_TOOL_CALLS + 2),
            maxRetries: 3,
        });
        reply = { calls, text: result.text };
        await fs.writeFile(cacheFile, `${JSON.stringify(reply, null, 2)}\n`);
    }

    const answer = parseAnswer(reply.text);
    const ranked: RankedFile[] = seen.map((filePath) => ({ path: filePath, matchedTermCount: 0 }));
    const mustFiles = [...job.grades]
        .filter(([, grade]) => grade === 2)
        .map(([filePath]) => filePath);
    const targets = mustFiles.length > 0 ? mustFiles : [...job.grades.keys()];
    const searchCalls = reply.calls.filter((call) => call.tool === "memory_search");
    const dateCall = reply.calls.find((call) => call.tool === "memory_datesearch");
    return {
        caseId: job.evalCase.id,
        category: job.evalCase.category,
        run: job.run,
        terms: searchCalls.flatMap((call) =>
            Array.isArray(call.args.terms) ? call.args.terms.map(String) : [],
        ),
        dates: dateCall ? describeDateArgs(dateCall.args) : undefined,
        grades: Object.fromEntries(job.grades),
        ranked,
        metrics: scoreCase(ranked, job.grades),
        agent: {
            calls: reply.calls,
            answer,
            answerPrecision:
                answer.length === 0
                    ? null
                    : answer.filter((filePath) => job.grades.has(filePath)).length / answer.length,
            answerRecall:
                job.grades.size === 0
                    ? null
                    : targets.filter((filePath) => answer.includes(filePath)).length /
                      targets.length,
            isCached,
        },
    };
}

/**
 * Executes one tool call against the index, like the live tools.
 *
 * @param index - The corpus index.
 * @param call - The call.
 * @param settings - Search knobs.
 * @returns The rendered result and the file paths it listed, in order.
 */
async function executeToolCall(
    index: WikiIndex,
    call: AgentToolCall,
    settings: EvalSearchSettings,
): Promise<{ text: string; paths: string[] }> {
    try {
        if (call.tool === "memory_search") {
            const terms = Array.isArray(call.args.terms)
                ? call.args.terms.filter((term): term is string => typeof term === "string")
                : [];
            prepareTerms(terms);
            const hits = await searchFiles(index, terms, {
                limit: SEARCH_LIMIT,
                similarityThreshold: settings.similarityThreshold,
                weights: settings.weights,
            });
            return { text: renderFileHits(hits, terms), paths: hits.map((hit) => hit.path) };
        }
        const query = parseDateSearchArgs(
            call.args as { from?: string; to?: string; day?: string },
        );
        const result = await searchDates(index, query);
        const paths = [...new Set(result.hits.map((hit) => hit.path))];
        return { text: renderDateHits(result, query), paths };
    } catch (err) {
        return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, paths: [] };
    }
}

/**
 * Reads a cached reply.
 *
 * @param cacheFile - Cache file path.
 * @returns The reply, or `undefined` when not cached.
 * @throws {Error} When the file exists but can't be read.
 */
async function readCachedReply(cacheFile: string): Promise<CachedReply | undefined> {
    try {
        return JSON.parse(await fs.readFile(cacheFile, "utf8")) as CachedReply;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw err;
    }
}

/**
 * Extracts the paths of the model's last `FILES:` line.
 *
 * @param text - The model's final text.
 * @returns Workspace-relative paths (backticks stripped, `wiki/` prefixed when missing).
 */
export function parseAnswer(text: string): string[] {
    const line = text
        .split("\n")
        .reverse()
        .find((entry) => /^\s*\**FILES:?\**/i.test(entry));
    if (!line) {
        return [];
    }
    const list = line.replace(/^\s*\**FILES:?\**:?/i, "").trim();
    if (/^none\b/i.test(list)) {
        return [];
    }
    return list
        .split(",")
        .map((entry) => entry.trim().replace(/[`*[\]]/g, ""))
        .filter((entry) => entry.endsWith(".md"))
        .map((entry) => (entry.startsWith("wiki/") ? entry : `wiki/${entry.replace(/^\/+/, "")}`));
}

/**
 * Turns date-search arguments into a query for the report, when valid.
 *
 * @param args - The arguments.
 * @returns The query, or `undefined` when invalid.
 */
function describeDateArgs(args: Record<string, unknown>): DateQuery | undefined {
    try {
        return parseDateSearchArgs(args as { from?: string; to?: string; day?: string });
    } catch {
        return undefined;
    }
}
