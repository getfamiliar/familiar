import { markdownTable } from "@getfamiliar/shared";
import type { AgentCaseRunResult, AgentEvalResult } from "./EvalAgent.js";
import { EVAL_CATEGORIES } from "./EvalCases.js";
import { aggregateMetrics } from "./EvalMetrics.js";
import type { CaseRunResult, EvalRunLabel, MemoryEvalResult } from "./EvalRunner.js";
import type { DateQuery } from "./WikiSearch.js";

/**
 * Renders a {@link MemoryEvalResult} as the markdown report of `familiar memory eval`.
 */

/** Maximum query preview length in table cells. */
const QUERY_PREVIEW_CHARS = 60;

/** Report display options. */
export interface EvalReportOptions {
    /** Also list every positive case with a must-have file missing from the top 5. */
    readonly isFailureListShown: boolean;
}

/**
 * Renders the full report.
 *
 * @param result - The eval result.
 * @param opts - Display options.
 * @returns Markdown.
 */
export function renderEvalReport(
    result: MemoryEvalResult | AgentEvalResult,
    opts: EvalReportOptions,
): string {
    const runs = listRuns(result.results);
    const { weights, similarityThreshold } = result.settings;
    const agentResults = "modelLabel" in result ? result.results : undefined;
    const sections: string[] = [
        agentResults ? "# Memory eval — LLM stage" : "# Memory eval",
        [
            ...("modelLabel" in result
                ? [
                      `- Model: \`${result.modelLabel}\` formulates the searches from each case's prompt`,
                  ]
                : []),
            `- Similarity threshold: ${similarityThreshold}`,
            `- Field weights: title ${weights.title}, category ${weights.category}, description ${weights.description}, heading ${weights.heading}, body ${weights.body}`,
            `- Started: ${result.startedAt}`,
        ].join("\n"),
        renderIndexingSection(result),
        renderOverview(result.results, runs),
        renderCategoryTable(result.results, runs),
        agentResults ? renderAgentOverview(agentResults, runs) : renderNegatives(result.results),
    ];
    if (opts.isFailureListShown) {
        sections.push(
            agentResults ? renderAgentFailures(agentResults) : renderFailures(result.results),
        );
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
        `\`${corpus.schema}\``,
        String(corpus.wikiFiles),
        String(corpus.indexedFiles),
        String(corpus.written),
    ]);
    const lines = [
        "## Index",
        markdownTable(["Corpus", "Schema", "Wiki files", "Indexed", "Written now"], rows),
    ];
    if (result.caseProblems.length > 0) {
        lines.push(
            `**${result.caseProblems.length} invalid case(s) skipped** — run \`npx tsx plugins/memory/eval/ValidateCases.ts\`.`,
        );
    }
    return lines.join("\n\n");
}

/**
 * Renders the per-run overview of the ranking metrics.
 *
 * @param results - Case results.
 * @param runs - Runs to show.
 * @returns Markdown section.
 */
function renderOverview(results: readonly CaseRunResult[], runs: readonly EvalRunLabel[]): string {
    const rows = runs.map((run) => {
        const aggregate = aggregateMetrics(
            results.filter((result) => result.run === run).map((result) => result.metrics),
        );
        return [
            run,
            String(aggregate.caseCount),
            formatPercent(aggregate.recallAt5),
            formatPercent(aggregate.recallAt10),
            formatPercent(aggregate.hitAt1),
            formatDecimal(aggregate.mrr),
            formatDecimal(aggregate.ndcgAt10),
        ];
    });
    return [
        "## Overview",
        "Over positive cases. The agent reads the whole result table, so *Recall@5* (share of must-have files within the top 5) is the main measure; Hit@1, MRR and nDCG@10 are for comparison.",
        markdownTable(["Run", "Cases", "Recall@5", "Recall@10", "Hit@1", "MRR", "nDCG@10"], rows),
    ].join("\n\n");
}

/**
 * Renders Recall@5 and Hit@1 per category and run.
 *
 * @param results - Case results.
 * @param runs - Runs to show.
 * @returns Markdown section.
 */
function renderCategoryTable(
    results: readonly CaseRunResult[],
    runs: readonly EvalRunLabel[],
): string {
    const headers = ["Category", ...runs.flatMap((run) => [`${run} R@5`, `${run} Hit@1`])];
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
                `${formatPercent(aggregate.recallAt5)} (${aggregate.caseCount})`,
                formatPercent(aggregate.hitAt1),
            ];
        }),
    ]);
    return ["## Per category", markdownTable(headers, rows)].join("\n\n");
}

/**
 * Renders the negative cases: how many files came back and how well the top one matched. An empty
 * result or a top file matching only some terms is what lets the agent conclude "nothing known".
 *
 * @param results - Case results.
 * @returns Markdown section (empty when no negative case ran).
 */
function renderNegatives(results: readonly CaseRunResult[]): string {
    const rows = results
        .filter((result) => result.metrics.isHitAt1 === null)
        .map((result) => {
            const top = result.ranked[0];
            return [
                result.caseId,
                result.run,
                describeQuery(result.terms, result.dates),
                String(result.metrics.resultCount),
                top
                    ? `${shortPath(top.path)} (${top.matchedTermCount}/${result.terms.length} terms)`
                    : "—",
            ];
        });
    if (rows.length === 0) {
        return "";
    }
    return [
        "## Negative cases",
        "Nothing relevant exists. Fewer results, and a top file that matches only some of the terms, make it easier for the agent to conclude that.",
        markdownTable(["Case", "Run", "Terms", "Results", "Top file"], rows),
    ].join("\n\n");
}

/**
 * Renders what the model did per run: whether its answer named the must-have files, how many
 * searches it needed, and how often it answered "none" on negative cases.
 *
 * @param results - Case results with traces.
 * @param runs - Runs to show.
 * @returns Markdown section.
 */
function renderAgentOverview(
    results: readonly AgentCaseRunResult[],
    runs: readonly EvalRunLabel[],
): string {
    const rows = runs.map((run) => {
        const runResults = results.filter((result) => result.run === run);
        const positives = runResults.filter((result) => result.agent.answerRecall !== null);
        const negatives = runResults.filter((result) => result.agent.answerRecall === null);
        const mean = (values: readonly number[]): number =>
            values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
        return [
            run,
            formatPercent(mean(positives.map((result) => result.agent.answerRecall ?? 0))),
            formatPercent(
                mean(
                    positives.flatMap((result) =>
                        result.agent.answerPrecision === null ? [] : [result.agent.answerPrecision],
                    ),
                ),
            ),
            formatDecimal(mean(positives.map((result) => result.agent.answer.length))),
            negatives.length === 0
                ? "—"
                : `${negatives.filter((result) => result.agent.answer.length === 0).length}/${negatives.length}`,
            formatDecimal(mean(runResults.map((result) => result.agent.calls.length))),
            String(runResults.filter((result) => result.agent.calls.length === 0).length),
            `${runResults.filter((result) => result.agent.isCached).length}/${runResults.length}`,
        ];
    });
    return [
        "## Agent",
        "*Answer recall*: share of must-have files the model named in its final `FILES:` line; *answer precision*: share of named files that are graded relevant (positive cases). The ranking metrics above use every file the model saw in its search results, in order of appearance.",
        markdownTable(
            [
                "Run",
                "Answer recall",
                "Answer precision",
                "Files / answer",
                "Negatives answered none",
                "Tool calls / case",
                "No search",
                "Cached",
            ],
            rows,
        ),
    ].join("\n\n");
}

/**
 * Lists cases whose answer misses a must-have file, or negative cases answered with files, with
 * the model's searches.
 *
 * @param results - Case results with traces.
 * @returns Markdown section.
 */
function renderAgentFailures(results: readonly AgentCaseRunResult[]): string {
    const rows = results
        .filter((result) =>
            result.agent.answerRecall === null
                ? result.agent.answer.length > 0
                : result.agent.answerRecall < 1,
        )
        .map((result) => [
            result.caseId,
            result.run,
            result.agent.calls
                .map((call) =>
                    call.tool === "memory_search"
                        ? `search ${JSON.stringify(call.args.terms ?? [])}`
                        : `dates ${JSON.stringify(call.args)}`,
                )
                .join("; ") || "(no search)",
            Object.entries(result.grades)
                .filter(([, grade]) => grade === 2)
                .map(([filePath]) => shortPath(filePath))
                .join(", ") || "(nothing)",
            result.agent.answer.map((filePath) => shortPath(filePath)).join(", ") || "none",
        ]);
    return [
        "## Agent misses",
        rows.length === 0
            ? "Every answer named all must-have files, and every negative case was answered with none."
            : markdownTable(["Case", "Run", "Searches", "Expected", "Answer"], rows),
    ].join("\n\n");
}

/**
 * Lists positive cases with a must-have file missing from the top 5.
 *
 * @param results - Case results.
 * @returns Markdown section.
 */
function renderFailures(results: readonly CaseRunResult[]): string {
    const rows = results
        .filter((result) => result.metrics.recallAt5 !== null && result.metrics.recallAt5 < 1)
        .map((result) => {
            const expected = Object.entries(result.grades)
                .filter(([, grade]) => grade === 2)
                .map(([filePath]) => filePath);
            const rank = result.metrics.firstRelevantRank;
            return [
                result.caseId,
                result.run,
                describeQuery(result.terms, result.dates),
                expected.map((filePath) => shortPath(filePath)).join(", ") || "(grade 1 only)",
                rank === null ? "not found" : `#${rank}`,
                result.ranked
                    .slice(0, 3)
                    .map((file) => `${shortPath(file.path)} (${file.matchedTermCount})`)
                    .join("; "),
            ];
        });
    return [
        "## Misses",
        rows.length === 0
            ? "Every positive case has all must-have files within the top 5."
            : markdownTable(
                  ["Case", "Run", "Terms", "Expected", "First relevant", "Top 3 (terms matched)"],
                  rows,
              ),
    ].join("\n\n");
}

/**
 * Summarizes a case's search input for a table cell.
 *
 * @param terms - The terms.
 * @param dates - The date query.
 * @returns E.g. `Tobias Hartl · day 05-25`.
 */
function describeQuery(terms: readonly string[], dates: DateQuery | undefined): string {
    const parts = terms.length > 0 ? [terms.join(", ")] : [];
    if (dates) {
        parts.push("day" in dates ? `day ${dates.day}` : `${dates.from}…${dates.to}`);
    }
    const flat = parts.join(" · ");
    return flat.length <= QUERY_PREVIEW_CHARS ? flat : `${flat.slice(0, QUERY_PREVIEW_CHARS - 1)}…`;
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
 * Formats a share as a whole percentage.
 *
 * @param share - Value in [0, 1].
 * @returns E.g. `"73%"`.
 */
function formatPercent(share: number): string {
    return `${Math.round(share * 100)}%`;
}

/**
 * Formats a mean with two decimals.
 *
 * @param value - The number.
 * @returns E.g. `"0.62"`.
 */
function formatDecimal(value: number): string {
    return value.toFixed(2);
}
