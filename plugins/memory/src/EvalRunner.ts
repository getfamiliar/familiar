import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HostContext, Logger, WorkspaceFile, WorkspaceWatcherApi } from "@getfamiliar/shared";
import { buildMemoryStore } from "./BuildStore.js";
import type { MemoryConfig } from "./Config.js";
import { type EvalCase, type EvalCategory, type EvalLanguage, loadEvalCases } from "./EvalCases.js";
import { type CaseMetrics, type RankedFile, scoreCase } from "./EvalMetrics.js";
import type { MemoryStore } from "./MemoryStore.js";

/**
 * Runs the memory eval set (`eval/cases.yml`) against the real {@link MemoryStore}: indexes each
 * corpus into a cached throwaway index, runs every query and scores the ranked files.
 */

/** Provider resolver, as exposed by `ctx.inference.resolveProvider`. */
type ResolveProvider = HostContext["inference"]["resolveProvider"];

/**
 * A run: the query language and the corpus it is searched against. `en→de` runs the English
 * query of cross-language cases against the German corpus.
 */
export type EvalRunLabel = "de" | "en" | "en→de";

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
    /** Effective memory config, including any CLI overrides. */
    readonly config: MemoryConfig;
    /** Directory holding one cached index per corpus language and config identity. */
    readonly cacheDir: string;
    /** Provider resolution for the embedding model. */
    readonly resolveProvider: ResolveProvider;
    /** Logger for the store; the CLI passes one that only forwards warnings and errors. */
    readonly log: Logger;
    /** Receives one short progress line per step (indexing, running a run). */
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
    /** The query as sent to the store. */
    readonly query: string;
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
    /** Markdown files in the corpus. */
    readonly corpusFiles: number;
    /** Files present in the index after the sync. */
    readonly indexedFiles: number;
    /** Chunks in the index after the sync. */
    readonly chunks: number;
    /** Corpus files missing from the index (indexing failed; see log). */
    readonly missingFiles: readonly string[];
}

/** Everything {@link runMemoryEval} measured. */
export interface MemoryEvalResult {
    /** Embedding provider/model label. */
    readonly embedding: string;
    /** The search-relevant config the run used. */
    readonly settings: {
        readonly language: string;
        readonly hybridWeights: { readonly vector: number; readonly text: number };
        readonly minVectorSimilarity: number;
        readonly minScoreToMention: number;
        readonly maxChunkChars: number;
    };
    /** ISO timestamp of the run. */
    readonly startedAt: string;
    /** Problems found in `cases.yml`; invalid cases are skipped. */
    readonly caseProblems: readonly string[];
    /** Indexing summary per corpus. */
    readonly corpora: readonly CorpusIndexSummary[];
    /** Every case result, in case order per run. */
    readonly results: readonly CaseRunResult[];
}

/** Chunk hits requested per query; aggregated to files afterwards. */
const CHUNK_HIT_LIMIT = 60;

/** Files kept per query after aggregating chunk hits. */
const RANKED_FILE_LIMIT = 20;

/** Queries in flight at once (each one embedding call). */
const QUERY_CONCURRENCY = 4;

/** Longest time to wait for a corpus to be indexed. */
const INDEX_TIMEOUT_MS = 15 * 60 * 1000;

/** Poll interval while waiting for the index to become ready. */
const INDEX_POLL_MS = 250;

/**
 * Indexes the selected corpora and runs every selected case.
 *
 * @param opts - Eval inputs.
 * @returns All case results plus indexing and config metadata.
 * @throws {Error} When the embedding handshake fails or a corpus cannot be indexed in time.
 */
export async function runMemoryEval(opts: MemoryEvalOptions): Promise<MemoryEvalResult> {
    const startedAt = new Date().toISOString();
    const caseSet = loadEvalCases(opts.evalDir);
    const cases = caseSet.cases.filter((evalCase) => isCaseSelected(evalCase, opts));
    const isCrossRunSelected = opts.languages.includes("de") && opts.languages.includes("en");

    const corpora: CorpusIndexSummary[] = [];
    const results: CaseRunResult[] = [];
    let embedding = "";
    for (const language of opts.languages) {
        opts.onProgress(`indexing corpus/${language} …`);
        const opened = await openCorpusStore(language, opts);
        opts.onProgress(
            `corpus/${language}: ${opened.summary.indexedFiles}/${opened.summary.corpusFiles} files, ${opened.summary.chunks} chunks — running ${cases.length} cases`,
        );
        embedding = opened.embedding;
        corpora.push(opened.summary);
        try {
            results.push(
                ...(await runCases(opened.store, cases, language, (evalCase) => ({
                    query: evalCase.query[language],
                    grades: evalCase.relevant[language],
                }))),
            );
            if (language === "de" && isCrossRunSelected) {
                const crossCases = cases.filter((evalCase) => evalCase.crossLanguage);
                opts.onProgress(`running ${crossCases.length} cross-language cases (en→de)`);
                results.push(
                    ...(await runCases(opened.store, crossCases, "en→de", (evalCase) => ({
                        query: evalCase.query.en,
                        grades: evalCase.relevant.de,
                    }))),
                );
            }
        } finally {
            await opened.store.close();
        }
    }

    return {
        embedding,
        settings: {
            language: opts.config.language,
            hybridWeights: opts.config.hybridWeights,
            minVectorSimilarity: opts.config.minVectorSimilarity,
            minScoreToMention: opts.config.minScoreToMention,
            maxChunkChars: opts.config.maxChunkChars,
        },
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
 * Builds the store for one corpus and brings its cached index up to date.
 *
 * The cache directory is keyed by corpus language and tokenizer language: the persisted Orama
 * index carries token trees built with the tokenizer, so a different stemmer needs its own index.
 * Embedding identity changes are handled by the store's own handshake (rebuild on model change),
 * chunk changes by its diff-aware re-embed.
 *
 * @param language - Corpus language.
 * @param opts - Eval inputs.
 * @returns The ready store, the embedding label and the indexing summary.
 * @throws {Error} When the embedding handshake fails or indexing times out.
 */
async function openCorpusStore(
    language: EvalLanguage,
    opts: MemoryEvalOptions,
): Promise<{
    readonly store: MemoryStore;
    readonly embedding: string;
    readonly summary: CorpusIndexSummary;
}> {
    const corpusDir = path.join(opts.evalDir, "corpus", language);
    const cacheKey = `${language}-${opts.config.language}-${opts.config.maxChunkChars}`;
    const built = await buildMemoryStore(
        opts.config,
        opts.resolveProvider,
        path.join(opts.cacheDir, cacheKey),
        corpusDir,
        opts.log,
    );
    if (!built) {
        throw new Error(
            "memory eval: embedding handshake failed — check memory.embeddings in config.yml",
        );
    }
    const store = built.store;
    const corpusFiles = await listCorpusMarkdownFiles(corpusDir);
    await store.init();
    store.kickoffBackgroundSync(staticWorkspace(corpusFiles));
    await waitUntilReady(store, language);

    const indexed = store.listFiles();
    const indexedPaths = new Set(indexed.map((file) => file.relativePath));
    return {
        store,
        embedding: built.providerLabel,
        summary: {
            language,
            corpusFiles: corpusFiles.length,
            indexedFiles: indexed.length,
            chunks: indexed.reduce((sum, file) => sum + file.chunkCount, 0),
            missingFiles: corpusFiles
                .map((file) => file.relativePath)
                .filter((relativePath) => !indexedPaths.has(relativePath)),
        },
    };
}

/**
 * Lists every markdown file below a corpus directory.
 *
 * @param corpusDir - Absolute path of `corpus/<language>/`.
 * @returns The files with POSIX workspace-relative paths, sorted.
 * @throws {Error} When the directory cannot be read.
 */
async function listCorpusMarkdownFiles(corpusDir: string): Promise<WorkspaceFile[]> {
    const entries = await fs.readdir(corpusDir, { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => {
            const absolutePath = path.join(entry.parentPath, entry.name);
            return {
                relativePath: path.relative(corpusDir, absolutePath).split(path.sep).join("/"),
                absolutePath,
            };
        })
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Wraps a fixed file list in the workspace watcher interface the store syncs from. The corpus
 * does not change during a run, so there are no live transitions.
 *
 * @param files - The corpus files.
 * @returns A watcher whose snapshot is the file list and whose subscription never fires.
 */
function staticWorkspace(files: readonly WorkspaceFile[]): WorkspaceWatcherApi {
    return {
        listMarkdownFiles: async () => files,
        onMarkdownFileUpdate: () => () => {},
    };
}

/**
 * Waits until the store has drained its initial indexing batch.
 *
 * @param store - The syncing store.
 * @param language - Corpus language, for the timeout message.
 * @throws {Error} When the index is not ready within {@link INDEX_TIMEOUT_MS}.
 */
async function waitUntilReady(store: MemoryStore, language: EvalLanguage): Promise<void> {
    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    while (!store.isReady()) {
        if (Date.now() > deadline) {
            throw new Error(
                `memory eval: indexing corpus/${language} did not finish within ${INDEX_TIMEOUT_MS / 60000} minutes`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, INDEX_POLL_MS));
    }
}

/**
 * Runs a list of cases against one store, a few queries at a time.
 *
 * @param store - The ready store.
 * @param cases - Cases to run.
 * @param run - Run label recorded on each result.
 * @param pick - Selects the query and the judging grades of a case for this run.
 * @returns One result per case, in case order.
 * @throws {Error} When a search fails (e.g. the embedding call).
 */
async function runCases(
    store: MemoryStore,
    cases: readonly EvalCase[],
    run: EvalRunLabel,
    pick: (evalCase: EvalCase) => {
        readonly query: string;
        readonly grades: ReadonlyMap<string, number>;
    },
): Promise<CaseRunResult[]> {
    const results: CaseRunResult[] = new Array(cases.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        while (nextIndex < cases.length) {
            const index = nextIndex++;
            const evalCase = cases[index];
            const { query, grades } = pick(evalCase);
            const hits = await store.search(query, { limit: CHUNK_HIT_LIMIT });
            const ranked = rankFiles(hits);
            results[index] = {
                caseId: evalCase.id,
                category: evalCase.category,
                run,
                query,
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
 * Collapses chunk hits to one entry per file (best score), as the prompt appender does.
 *
 * @param hits - Chunk hits from the store.
 * @returns Files sorted by best score, capped at {@link RANKED_FILE_LIMIT}.
 */
function rankFiles(
    hits: readonly { readonly relativePath: string; readonly score: number }[],
): RankedFile[] {
    const bestByPath = new Map<string, number>();
    for (const hit of hits) {
        bestByPath.set(
            hit.relativePath,
            Math.max(bestByPath.get(hit.relativePath) ?? 0, hit.score),
        );
    }
    return [...bestByPath]
        .map(([filePath, score]) => ({ path: filePath, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, RANKED_FILE_LIMIT);
}
