/**
 * Pure scoring functions for the memory eval runner: per-case ranking metrics and their
 * aggregation. Kept free of I/O so they can be unit-tested.
 *
 * Scores are not calibrated across queries any more (the search ranks by matched-term count, then
 * a weighted similarity), so there is no score floor to tune. The agent reads the whole result
 * table, which makes recall within the top 5 / 10 the main measure.
 */

/** One file in a case's result list, best first. */
export interface RankedFile {
    /** Workspace-relative path. */
    readonly path: string;
    /** How many of the case's terms matched the file (date-only results: 0). */
    readonly matchedTermCount: number;
}

/** Metrics of one case in one run. Ranking metrics are `null` for negative cases. */
export interface CaseMetrics {
    /** Top-ranked file has grade ≥ 1. */
    readonly isHitAt1: boolean | null;
    /** Share of grade-2 files (grade ≥ 1 when there is none) within the top 5. */
    readonly recallAt5: number | null;
    /** Same within the top 10. */
    readonly recallAt10: number | null;
    /** 1 / rank of the first file with grade ≥ 1, 0 when none is ranked. */
    readonly reciprocalRank: number | null;
    /** Normalized discounted cumulative gain over the top 10, gain = grade. */
    readonly ndcgAt10: number | null;
    /** 1-based rank of the first file with grade ≥ 1, `null` when none is ranked. */
    readonly firstRelevantRank: number | null;
    /** Number of files returned. */
    readonly resultCount: number;
}

/** Aggregated ranking metrics over a set of positive cases. */
export interface AggregateMetrics {
    /** Number of cases aggregated (positive cases only). */
    readonly caseCount: number;
    /** Mean of {@link CaseMetrics.isHitAt1}. */
    readonly hitAt1: number;
    /** Mean of {@link CaseMetrics.recallAt5}. */
    readonly recallAt5: number;
    /** Mean of {@link CaseMetrics.recallAt10}. */
    readonly recallAt10: number;
    /** Mean reciprocal rank. */
    readonly mrr: number;
    /** Mean of {@link CaseMetrics.ndcgAt10}. */
    readonly ndcgAt10: number;
}

/** Number of ranked files the nDCG looks at. */
const NDCG_DEPTH = 10;

/**
 * Computes the metrics of one case.
 *
 * @param ranked - The case's result files, best first.
 * @param grades - Expected files with grade 1 or 2; empty for a negative case.
 * @returns The case's metrics.
 */
export function scoreCase(
    ranked: readonly RankedFile[],
    grades: ReadonlyMap<string, number>,
): CaseMetrics {
    if (grades.size === 0) {
        return {
            isHitAt1: null,
            recallAt5: null,
            recallAt10: null,
            reciprocalRank: null,
            ndcgAt10: null,
            firstRelevantRank: null,
            resultCount: ranked.length,
        };
    }

    const hasMustFiles = [...grades.values()].some((grade) => grade === 2);
    const targetGrade = hasMustFiles ? 2 : 1;
    const targets = [...grades].filter(([, grade]) => grade >= targetGrade).map(([path]) => path);
    const recallAt = (depth: number): number => {
        const top = new Set(ranked.slice(0, depth).map((file) => file.path));
        return targets.filter((path) => top.has(path)).length / targets.length;
    };

    const firstIndex = ranked.findIndex((file) => grades.has(file.path));
    const firstRelevantRank = firstIndex === -1 ? null : firstIndex + 1;
    return {
        isHitAt1: firstRelevantRank === 1,
        recallAt5: recallAt(5),
        recallAt10: recallAt(10),
        reciprocalRank: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
        ndcgAt10: computeNdcg(ranked, grades),
        firstRelevantRank,
        resultCount: ranked.length,
    };
}

/**
 * Computes nDCG@10 with gain = grade.
 *
 * @param ranked - Result files, best first.
 * @param grades - Expected files with grade 1 or 2 (non-empty).
 * @returns nDCG in [0, 1].
 */
function computeNdcg(ranked: readonly RankedFile[], grades: ReadonlyMap<string, number>): number {
    const discountedGain = (grade: number, index: number): number =>
        (2 ** grade - 1) / Math.log2(index + 2);
    const dcg = ranked
        .slice(0, NDCG_DEPTH)
        .reduce((sum, file, index) => sum + discountedGain(grades.get(file.path) ?? 0, index), 0);
    const idealDcg = [...grades.values()]
        .sort((a, b) => b - a)
        .slice(0, NDCG_DEPTH)
        .reduce((sum, grade, index) => sum + discountedGain(grade, index), 0);
    return idealDcg === 0 ? 0 : dcg / idealDcg;
}

/**
 * Averages the ranking metrics of the positive cases in a list.
 *
 * @param metrics - Case metrics; negative cases (null ranking metrics) are skipped.
 * @returns The aggregate, all zeros when there is no positive case.
 */
export function aggregateMetrics(metrics: readonly CaseMetrics[]): AggregateMetrics {
    const positives = metrics.filter((entry) => entry.isHitAt1 !== null);
    const mean = (pick: (entry: CaseMetrics) => number): number =>
        positives.length === 0
            ? 0
            : positives.reduce((sum, entry) => sum + pick(entry), 0) / positives.length;
    return {
        caseCount: positives.length,
        hitAt1: mean((entry) => (entry.isHitAt1 ? 1 : 0)),
        recallAt5: mean((entry) => entry.recallAt5 ?? 0),
        recallAt10: mean((entry) => entry.recallAt10 ?? 0),
        mrr: mean((entry) => entry.reciprocalRank ?? 0),
        ndcgAt10: mean((entry) => entry.ndcgAt10 ?? 0),
    };
}
