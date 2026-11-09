import * as path from "node:path";
import type { DatabaseApi, Logger } from "@getfamiliar/shared";
import { type EvalCase, type EvalCategory, type EvalLanguage, loadEvalCases } from "./EvalCases.js";
import { type CaseMetrics, type RankedFile, scoreCase } from "./EvalMetrics.js";
import { listWikiFiles, WikiIndex } from "./WikiIndex.js";
import {
    type DateQuery,
    DEFAULT_FIELD_WEIGHTS,
    DEFAULT_SIMILARITY_THRESHOLD,
    type FieldWeights,
    searchDates,
    searchFiles,
} from "./WikiSearch.js";

/**
 * Runs the memory eval set (`eval/cases.yml`) against the real wiki index: indexes each corpus's
 * `wiki/` into its own postgres schema (`memory_eval_<lang>`), runs every case's terms and dates
 * and scores the ranked files.
 */

/**
 * A run: the term language and the corpus it is searched against. `en→de` runs the English terms
 * of cross-language cases against the German corpus.
 */
export type EvalRunLabel = "de" | "en" | "en→de";

/** Search knobs the eval can vary. */
export interface EvalSearchSettings {
    /** Word-similarity threshold. */
    readonly similarityThreshold: number;
    /** Field weights. */
    readonly weights: FieldWeights;
}

/** Default {@link EvalSearchSettings}: the production defaults. */
export const DEFAULT_EVAL_SETTINGS: EvalSearchSettings = {
    similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    weights: DEFAULT_FIELD_WEIGHTS,
};

/** Inputs of {@link runMemoryEval}. */
export interface MemoryEvalOptions {
    /** Absolute path of the eval folder (`cases.yml`, `corpus/`). */
    readonly evalDir: string;
    /** Corpus languages to evaluate; `en→de` runs when both are selected. */
    readonly languages: readonly EvalLanguage[];
    /** Only run cases of these categories (all when empty). */
    readonly categories: readonly string[];
    /** Only run cases whose id contains one of these substrings (all when empty). */
    readonly caseIdFilters: readonly string[];
    /** Search knobs. */
    readonly settings: EvalSearchSettings;
    /** Drop and rebuild the eval schemas instead of syncing them. */
    readonly isReindexForced: boolean;
    /** SQL access (`ctx.database`). */
    readonly database: DatabaseApi;
    /** Logger for indexing warnings. */
    readonly log: Logger;
    /** Receives one short progress line per step. */
    readonly onProgress: (message: string) => void;
}

/** Result of one case in one run. */
export interface CaseRunResult {
    /** Case id. */
    readonly caseId: string;
    /** Case category. */
    readonly category: EvalCategory;
    /** Run the case was executed in. */
    readonly run: EvalRunLabel;
    /** The terms sent (empty for date-only cases). */
    readonly terms: readonly string[];
    /** The date search run, if any. */
    readonly dates: DateQuery | undefined;
    /** Expected files with grades, judged against the run's corpus. */
    readonly grades: Readonly<Record<string, number>>;
    /** Result files, best first (up to {@link RANKED_FILE_LIMIT}). */
    readonly ranked: readonly RankedFile[];
    /** Metrics computed from {@link ranked} and {@link grades}. */
    readonly metrics: CaseMetrics;
}

/** Indexing outcome of one corpus. */
export interface CorpusIndexSummary {
    /** Corpus language. */
    readonly language: EvalLanguage;
    /** Postgres schema of the corpus index. */
    readonly schema: string;
    /** Markdown files under the corpus's `wiki/`. */
    readonly wikiFiles: number;
    /** Files in the index after the sync. */
    readonly indexedFiles: number;
    /** Files (re)written by this sync. */
    readonly written: number;
}

/** Everything {@link runMemoryEval} measured. */
export interface MemoryEvalResult {
    /** The search knobs the run used. */
    readonly settings: EvalSearchSettings;
    /** ISO timestamp of the run. */
    readonly startedAt: string;
    /** Problems found in `cases.yml`; invalid cases are skipped. */
    readonly caseProblems: readonly string[];
    /** Indexing summary per corpus. */
    readonly corpora: readonly CorpusIndexSummary[];
    /** Every case result, in case order per run. */
    readonly results: readonly CaseRunResult[];
}

/** Files kept per case. */
const RANKED_FILE_LIMIT = 20;

/** Date lines fetched per date search before grouping them by file. */
const DATE_LINE_LIMIT = 500;

/** Cases in flight at once. */
const QUERY_CONCURRENCY = 4;

/**
 * Postgres schema of a corpus's eval index.
 *
 * @param language - Corpus language.
 * @returns E.g. `memory_eval_de`.
 */
export function evalSchemaName(language: EvalLanguage): string {
    return `memory_eval_${language}`;
}

/**
 * Indexes the selected corpora and runs every selected case.
 *
 * @param opts - Eval inputs.
 * @returns All case results plus indexing metadata.
 * @throws {Error} When postgres is unreachable or a query fails.
 */
export async function runMemoryEval(opts: MemoryEvalOptions): Promise<MemoryEvalResult> {
    const startedAt = new Date().toISOString();
    const caseSet = loadEvalCases(opts.evalDir);
    const cases = caseSet.cases.filter((evalCase) => isCaseSelected(evalCase, opts));
    const isCrossRunSelected = opts.languages.includes("de") && opts.languages.includes("en");

    const corpora: CorpusIndexSummary[] = [];
    const results: CaseRunResult[] = [];
    for (const language of opts.languages) {
        opts.onProgress(`indexing corpus/${language}/wiki …`);
        const { index, summary } = await openCorpusIndex(language, opts);
        corpora.push(summary);
        opts.onProgress(
            `corpus/${language}: ${summary.indexedFiles} files (${summary.written} written) — running ${cases.length} cases`,
        );
        results.push(
            ...(await runCases(index, cases, language, opts.settings, (evalCase) => ({
                terms: evalCase.terms?.[language] ?? [],
                grades: evalCase.relevant[language],
            }))),
        );
        if (language === "de" && isCrossRunSelected) {
            const crossCases = cases.filter((evalCase) => evalCase.crossLanguage);
            opts.onProgress(`running ${crossCases.length} cross-language cases (en→de)`);
            results.push(
                ...(await runCases(index, crossCases, "en→de", opts.settings, (evalCase) => ({
                    terms: evalCase.terms?.en ?? [],
                    grades: evalCase.relevant.de,
                }))),
            );
        }
    }

    return {
        settings: opts.settings,
        startedAt,
        caseProblems: caseSet.problems,
        corpora,
        results,
    };
}

/**
 * Checks whether a case passes the category and id filters.
 *
 * @param evalCase - The case.
 * @param opts - Eval inputs with the filters.
 * @returns `true` when the case should run.
 */
function isCaseSelected(evalCase: EvalCase, opts: MemoryEvalOptions): boolean {
    const isCategoryMatch =
        opts.categories.length === 0 || opts.categories.includes(evalCase.category);
    const isIdMatch =
        opts.caseIdFilters.length === 0 ||
        opts.caseIdFilters.some((filter) => evalCase.id.includes(filter));
    return isCategoryMatch && isIdMatch;
}

/**
 * Brings one corpus's eval index up to date.
 *
 * @param language - Corpus language.
 * @param opts - Eval inputs.
 * @returns The index and its summary.
 * @throws {Error} When postgres is unreachable.
 */
export async function openCorpusIndex(
    language: EvalLanguage,
    opts: Pick<MemoryEvalOptions, "evalDir" | "database" | "log" | "isReindexForced">,
): Promise<{ readonly index: WikiIndex; readonly summary: CorpusIndexSummary }> {
    const corpusDir = path.join(opts.evalDir, "corpus", language);
    const index = new WikiIndex(opts.database, evalSchemaName(language), opts.log);
    if (opts.isReindexForced) {
        await index.dropSchema();
    }
    await index.ensureSchema();
    const sync = await index.syncAll(corpusDir);
    return {
        index,
        summary: {
            language,
            schema: index.schema,
            wikiFiles: (await listWikiFiles(corpusDir)).length,
            indexedFiles: await index.countFiles(),
            written: sync.written,
        },
    };
}

/**
 * Runs a list of cases against one index, a few at a time.
 *
 * @param index - The corpus index.
 * @param cases - Cases to run.
 * @param run - Run label recorded on each result.
 * @param settings - Search knobs.
 * @param pick - Selects the terms and the judging grades of a case for this run.
 * @returns One result per case, in case order.
 * @throws {Error} When a search fails.
 */
async function runCases(
    index: WikiIndex,
    cases: readonly EvalCase[],
    run: EvalRunLabel,
    settings: EvalSearchSettings,
    pick: (evalCase: EvalCase) => {
        readonly terms: readonly string[];
        readonly grades: ReadonlyMap<string, number>;
    },
): Promise<CaseRunResult[]> {
    const results: CaseRunResult[] = new Array(cases.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        while (nextIndex < cases.length) {
            const position = nextIndex++;
            const evalCase = cases[position];
            const { terms, grades } = pick(evalCase);
            const ranked = await rankCase(index, terms, evalCase.dates, settings);
            results[position] = {
                caseId: evalCase.id,
                category: evalCase.category,
                run,
                terms,
                dates: evalCase.dates,
                grades: Object.fromEntries(grades),
                ranked,
                metrics: scoreCase(ranked, grades),
            };
        }
    };
    await Promise.all(Array.from({ length: QUERY_CONCURRENCY }, () => worker()));
    return results;
}

/**
 * Runs a case's term search and/or date search and merges them into one ranked file list: files
 * found by both first (in term order), then term-only, then date-only files (most date lines
 * first).
 *
 * @param index - The corpus index.
 * @param terms - Search terms (may be empty).
 * @param dates - Date query, if any.
 * @param settings - Search knobs.
 * @returns The ranked files, capped at {@link RANKED_FILE_LIMIT}.
 */
export async function rankCase(
    index: WikiIndex,
    terms: readonly string[],
    dates: DateQuery | undefined,
    settings: EvalSearchSettings,
): Promise<RankedFile[]> {
    const termFiles: RankedFile[] =
        terms.length === 0
            ? []
            : (
                  await searchFiles(index, terms, {
                      limit: RANKED_FILE_LIMIT,
                      similarityThreshold: settings.similarityThreshold,
                      weights: settings.weights,
                  })
              ).map((hit) => ({ path: hit.path, matchedTermCount: hit.matchedTerms.length }));
    if (!dates) {
        return termFiles;
    }
    const dateFiles = await rankDateFiles(index, dates);
    if (termFiles.length === 0) {
        return dateFiles.slice(0, RANKED_FILE_LIMIT);
    }
    const datePaths = new Set(dateFiles.map((file) => file.path));
    const both = termFiles.filter((file) => datePaths.has(file.path));
    const termOnly = termFiles.filter((file) => !datePaths.has(file.path));
    const termPaths = new Set(termFiles.map((file) => file.path));
    const dateOnly = dateFiles.filter((file) => !termPaths.has(file.path));
    return [...both, ...termOnly, ...dateOnly].slice(0, RANKED_FILE_LIMIT);
}

/**
 * Groups date-search lines by file, most lines first, then earliest date.
 *
 * @param index - The corpus index.
 * @param dates - The date query.
 * @returns One entry per file.
 */
async function rankDateFiles(index: WikiIndex, dates: DateQuery): Promise<RankedFile[]> {
    const { hits } = await searchDates(index, dates, DATE_LINE_LIMIT);
    const byPath = new Map<string, { count: number; first: string }>();
    for (const hit of hits) {
        const entry = byPath.get(hit.path);
        if (entry) {
            entry.count++;
        } else {
            byPath.set(hit.path, { count: 1, first: hit.from });
        }
    }
    return [...byPath]
        .sort(
            ([pathA, a], [pathB, b]) =>
                b.count - a.count || a.first.localeCompare(b.first) || pathA.localeCompare(pathB),
        )
        .map(([filePath]) => ({ path: filePath, matchedTermCount: 0 }));
}
