import { markdownTable } from "@getfamiliar/shared";
import { EVAL_CATEGORIES } from "./EvalCases.js";
import {
    aggregateMetrics,
    percentiles,
    type ScorePercentiles,
    separationAuc,
    sweepThresholds,
} from "./EvalMetrics.js";
import type { CaseRunResult, EvalRunLabel, MemoryEvalResult } from "./EvalRunner.js";

/**
 * Renders a {@link MemoryEvalResult} as the markdown report of `familiar memory eval`.
 */

/** Score floors evaluated by the threshold sweep. */
const SWEEP_THRESHOLDS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];

/** Maximum query length shown in the failure list. */
const QUERY_PREVIEW_CHARS = 60;

/** Report display options. */
export interface EvalReportOptions {
    /** Also list every positive case whose top file is not relevant, and every negative case. */
    readonly isFailureListShown: boolean;
}

/**
 * Renders the full report.
 *
 * @param result - The eval result.
 * @param opts - Display options.
 * @returns Markdown.
 */
export function renderEvalReport(result: MemoryEvalResult, opts: EvalReportOptions): string {
    const runs = listRuns(result.results);
    const { settings } = result;
    const sections: string[] = [
        "# Memory eval",
        [
            `- Embedding: \`${result.embedding}\``,
            `- Tokenizer language: \`${settings.language}\``,
            `- Hybrid weights: vector ${settings.hybridWeights.vector}, text ${settings.hybridWeights.text}`,
            `- minVectorSimilarity: ${settings.minVectorSimilarity}, minScoreToMention: ${settings.minScoreToMention}, maxChunkChars: ${settings.maxChunkChars}`,
            `- Started: ${result.startedAt}`,
        ].join("\n"),
        renderIndexingSection(result),
        renderOverview(result.results, runs),
        renderCategoryTable(result.results, runs),
        renderScoreDistribution(result.results, runs),
        renderThresholdSweep(result.results, runs, settings.minScoreToMention),
    ];
    if (opts.isFailureListShown) {
        sections.push(renderFailures(result.results));
    }
    return `${sections.filter((section) => section.length > 0).join("\n\n")}\n`;
}

/**
 * Lists the runs present in the results, in fixed order.
 *
 * @param results - Case results.
 * @returns Run labels that have at least one result.
 */
function listRuns(results: readonly CaseRunResult[]): EvalRunLabel[] {
    const order: EvalRunLabel[] = ["de", "en", "en→de"];
    return order.filter((run) => results.some((result) => result.run === run));
}

/**
 * Renders the indexing summary and any case-file problems.
 *
 * @param result - The eval result.
 * @returns Markdown section.
 */
function renderIndexingSection(result: MemoryEvalResult): string {
    const rows = result.corpora.map((corpus) => [
        corpus.language,
        String(corpus.corpusFiles),
        String(corpus.indexedFiles),
        String(corpus.chunks),
        corpus.missingFiles.length === 0 ? "—" : corpus.missingFiles.join(", "),
    ]);
    const lines = [
        "## Index",
        markdownTable(["Corpus", "Files", "Indexed", "Chunks", "Missing"], rows),
    ];
    if (result.caseProblems.length > 0) {
        lines.push(
            `**${result.caseProblems.length} invalid case(s) skipped** — run \`npx tsx plugins/memory/eval/ValidateCases.ts\`.`,
        );
    }
    return lines.join("\n\n");
}

/**
 * Renders the per-run overview: ranking metrics and score separability.
 *
 * @param results - Case results.
 * @param runs - Runs to show.
 * @returns Markdown section.
 */
function renderOverview(results: readonly CaseRunResult[], runs: readonly EvalRunLabel[]): string {
    const rows = runs.map((run) => {
        const runResults = results.filter((result) => result.run === run);
        const metrics = runResults.map((result) => result.metrics);
        const aggregate = aggregateMetrics(metrics);
        const auc = separationAuc(
            metrics.flatMap((entry) =>
                entry.bestRelevantScore === null ? [] : [entry.bestRelevantScore],
            ),
            collectIrrelevantScores(runResults),
        );
        return [
            run,
            String(aggregate.caseCount),
            formatPercent(aggregate.hitAt1),
            formatPercent(aggregate.recallAt5),
            formatDecimal(aggregate.mrr),
            formatDecimal(aggregate.ndcgAt10),
            auc === null ? "—" : formatDecimal(auc),
        ];
    });
    return [
        "## Overview",
        "Ranking over positive cases. *Separation AUC*: probability that a case's best relevant file scores higher than an irrelevant top-10 file or a negative case's top file — 1.0 means one global score floor could separate them, 0.5 is chance.",
        markdownTable(
            ["Run", "Cases", "Hit@1", "Recall@5", "MRR", "nDCG@10", "Separation AUC"],
            rows,
        ),
    ].join("\n\n");
}

/**
 * Collects the scores that should stay below a score floor: irrelevant top-10 files of positive
 * cases and the top file of each negative case.
 *
 * @param runResults - Case results of one run.
 * @returns The scores.
 */
function collectIrrelevantScores(runResults: readonly CaseRunResult[]): number[] {
    return runResults.flatMap((result) => {
        if (result.metrics.isHitAt1 === null) {
            return result.metrics.topScore === null ? [] : [result.metrics.topScore];
        }
        return [...result.metrics.irrelevantScores];
    });
}

/**
 * Renders hit@1 and MRR per category and run.
 *
 * @param results - Case results.
 * @param runs - Runs to show.
 * @returns Markdown section.
 */
function renderCategoryTable(
    results: readonly CaseRunResult[],
    runs: readonly EvalRunLabel[],
): string {
    const headers = ["Category", ...runs.flatMap((run) => [`${run} Hit@1`, `${run} MRR`])];
    const rows = EVAL_CATEGORIES.filter(
        (category) =>
            category !== "negative" && results.some((result) => result.category === category),
    ).map((category) => [
        category,
        ...runs.flatMap((run) => {
            const metrics = results
                .filter((result) => result.run === run && result.category === category)
                .map((result) => result.metrics);
            if (metrics.length === 0) {
                return ["—", "—"];
            }
            const aggregate = aggregateMetrics(metrics);
            return [
                `${formatPercent(aggregate.hitAt1)} (${aggregate.caseCount})`,
                formatDecimal(aggregate.mrr),
            ];
        }),
    ]);
    return ["## Per category", markdownTable(headers, rows)].join("\n\n");
}

/**
 * Renders score percentiles of relevant files, irrelevant files and negative cases per run.
 *
 * @param results - Case results.
 * @param runs - Runs to show.
 * @returns Markdown section.
 */
function renderScoreDistribution(
    results: readonly CaseRunResult[],
    runs: readonly EvalRunLabel[],
): string {
    const rows = runs.flatMap((run) => {
        const runResults = results.filter((result) => result.run === run);
        const positives = runResults.filter((result) => result.metrics.isHitAt1 !== null);
        const negatives = runResults.filter((result) => result.metrics.isHitAt1 === null);
        return [
            percentileRow(
                run,
                "best relevant file",
                percentiles(
                    positives.flatMap((result) =>
                        result.metrics.bestRelevantScore === null
                            ? []
                            : [result.metrics.bestRelevantScore],
                    ),
                ),
            ),
            percentileRow(
                run,
                "irrelevant top-10 file",
                percentiles(positives.flatMap((result) => result.metrics.irrelevantScores)),
            ),
            percentileRow(
                run,
                "negative case, top file",
                percentiles(
                    negatives.flatMap((result) =>
                        result.metrics.topScore === null ? [] : [result.metrics.topScore],
                    ),
                ),
            ),
        ];
    });
    return [
        "## Score distribution",
        markdownTable(["Run", "Scores of", "n", "p10", "p50", "p90"], rows),
    ].join("\n\n");
}

/**
 * Formats one percentile row.
 *
 * @param run - Run label.
 * @param label - What the scores are.
 * @param stats - The percentiles.
 * @returns Table row.
 */
function percentileRow(run: string, label: string, stats: ScorePercentiles): string[] {
    const show = (value: number | null): string => (value === null ? "—" : formatDecimal(value));
    return [run, label, String(stats.count), show(stats.p10), show(stats.p50), show(stats.p90)];
}

/**
 * Renders the threshold sweep per run.
 *
 * @param results - Case results.
 * @param runs - Runs to show.
 * @param currentThreshold - Configured `minScoreToMention`, marked in the table.
 * @returns Markdown section.
 */
function renderThresholdSweep(
    results: readonly CaseRunResult[],
    runs: readonly EvalRunLabel[],
    currentThreshold: number,
): string {
    const thresholds = [...new Set([...SWEEP_THRESHOLDS, currentThreshold])].sort((a, b) => a - b);
    const sweeps = runs.map((run) =>
        sweepThresholds(
            results.filter((result) => result.run === run).map((result) => result.metrics),
            thresholds,
        ),
    );
    const headers = [
        "Floor",
        ...runs.flatMap((run) => [
            `${run} relevant kept`,
            `${run} irrelevant kept`,
            `${run} negatives empty`,
        ]),
    ];
    const rows = thresholds.map((threshold, index) => [
        threshold === currentThreshold ? `**${threshold}** (current)` : String(threshold),
        ...sweeps.flatMap((sweep) => [
            formatPercent(sweep[index].relevantKept),
            formatPercent(sweep[index].irrelevantKept),
            formatPercent(sweep[index].negativesSuppressed),
        ]),
    ]);
    return [
        "## Threshold sweep",
        "What a `minScoreToMention` floor would do: share of positive cases whose best relevant file stays visible, share of irrelevant top-10 files that stay visible, share of negative cases that would show nothing.",
        markdownTable(headers, rows),
    ].join("\n\n");
}

/**
 * Lists positive cases whose top file is not relevant, and every negative case with its top hit.
 *
 * @param results - Case results.
 * @returns Markdown section.
 */
function renderFailures(results: readonly CaseRunResult[]): string {
    const rows = results
        .filter((result) => result.metrics.isHitAt1 !== true)
        .map((result) => {
            const isNegative = result.metrics.isHitAt1 === null;
            const expected = Object.entries(result.grades)
                .filter(([, grade]) => grade === 2)
                .map(([filePath]) => filePath);
            const expectedCell = isNegative
                ? "(nothing)"
                : expected.map((filePath) => shortPath(filePath)).join(", ") || "(grade 1 only)";
            const rank = result.metrics.firstRelevantRank;
            return [
                result.caseId,
                result.run,
                previewQuery(result.query),
                expectedCell,
                isNegative ? "—" : rank === null ? "not found" : `#${rank}`,
                result.ranked
                    .slice(0, 3)
                    .map((file) => `${shortPath(file.path)} ${formatDecimal(file.score)}`)
                    .join("; "),
            ];
        });
    return [
        "## Misses",
        rows.length === 0
            ? "Every positive case has a relevant file at rank 1."
            : markdownTable(["Case", "Run", "Query", "Expected", "First relevant", "Top 3"], rows),
    ].join("\n\n");
}

/**
 * Shortens a workspace-relative path for table cells (`wiki/people/x.md` → `people/x`).
 *
 * @param filePath - Workspace-relative path.
 * @returns The short form.
 */
function shortPath(filePath: string): string {
    return filePath.replace(/^wiki\//, "").replace(/\.md$/, "");
}

/**
 * Collapses whitespace and truncates a query for a table cell.
 *
 * @param query - The query.
 * @returns The preview.
 */
function previewQuery(query: string): string {
    const flat = query.replace(/\s+/g, " ").trim();
    return flat.length <= QUERY_PREVIEW_CHARS ? flat : `${flat.slice(0, QUERY_PREVIEW_CHARS - 1)}…`;
}

/**
 * Formats a share as a whole percentage.
 *
 * @param share - Value in [0, 1].
 * @returns E.g. `"73%"`.
 */
function formatPercent(share: number): string {
    return `${Math.round(share * 100)}%`;
}

/**
 * Formats a score or mean with two decimals.
 *
 * @param value - The number.
 * @returns E.g. `"0.62"`.
 */
function formatDecimal(value: number): string {
    return value.toFixed(2);
}
