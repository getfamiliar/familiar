/**
 * Pure scoring functions for the memory eval runner: per-case ranking metrics, aggregation,
 * score distributions and the threshold sweep. Kept free of I/O so they can be unit-tested.
 */

/** One file in a case's result list, best chunk score per file, sorted by score descending. */
export interface RankedFile {
    /** Workspace-relative path. */
    readonly path: string;
    /** Best chunk score of the file, as the store reports it (0–1). */
    readonly score: number;
}

/** Metrics of one case in one run. Ranking metrics are `null` for negative cases. */
export interface CaseMetrics {
    /** Top-ranked file has grade ≥ 1. */
    readonly isHitAt1: boolean | null;
    /** Share of grade-2 files (grade ≥ 1 when there is none) within the top 5. */
    readonly recallAt5: number | null;
    /** 1 / rank of the first file with grade ≥ 1, 0 when none is ranked. */
    readonly reciprocalRank: number | null;
    /** Normalized discounted cumulative gain over the top 10, gain = grade. */
    readonly ndcgAt10: number | null;
    /** 1-based rank of the first file with grade ≥ 1, `null` when none is ranked. */
    readonly firstRelevantRank: number | null;
    /** Score of the top-ranked file, `null` when nothing was found. */
    readonly topScore: number | null;
    /** Best score among grade-2 files (grade ≥ 1 when there is none), `null` when none is ranked. */
    readonly bestRelevantScore: number | null;
    /** Scores of the ranked files that have grade ≥ 1. */
    readonly relevantScores: readonly number[];
    /** Scores of ranked files without a grade within the top 10. */
    readonly irrelevantScores: readonly number[];
}

/** Aggregated ranking metrics over a set of positive cases. */
export interface AggregateMetrics {
    /** Number of cases aggregated (positive cases only). */
    readonly caseCount: number;
    /** Mean of {@link CaseMetrics.isHitAt1}. */
    readonly hitAt1: number;
    /** Mean of {@link CaseMetrics.recallAt5}. */
    readonly recallAt5: number;
    /** Mean reciprocal rank. */
    readonly mrr: number;
    /** Mean of {@link CaseMetrics.ndcgAt10}. */
    readonly ndcgAt10: number;
}

/** 10th, 50th and 90th percentile of a score list. */
export interface ScorePercentiles {
    /** Number of scores. */
    readonly count: number;
    /** 10th percentile, `null` for an empty list. */
    readonly p10: number | null;
    /** Median, `null` for an empty list. */
    readonly p50: number | null;
    /** 90th percentile, `null` for an empty list. */
    readonly p90: number | null;
}

/** One row of the threshold sweep. */
export interface ThresholdRow {
    /** Score floor; a file passes when its score is strictly above it (as `minScoreToMention`). */
    readonly threshold: number;
    /** Share of positive cases whose best relevant file passes. */
    readonly relevantKept: number;
    /** Share of irrelevant top-10 files of positive cases that pass. */
    readonly irrelevantKept: number;
    /** Share of negative cases whose top file does not pass (nothing would be shown). */
    readonly negativesSuppressed: number;
}

/** Number of ranked files the nDCG looks at. */
const NDCG_DEPTH = 10;

/** Number of ranked files the recall looks at. */
const RECALL_DEPTH = 5;

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
    const topScore = ranked.length > 0 ? ranked[0].score : null;
    const irrelevantScores = ranked
        .slice(0, NDCG_DEPTH)
        .filter((file) => !grades.has(file.path))
        .map((file) => file.score);
    if (grades.size === 0) {
        return {
            isHitAt1: null,
            recallAt5: null,
            reciprocalRank: null,
            ndcgAt10: null,
            firstRelevantRank: null,
            topScore,
            bestRelevantScore: null,
            relevantScores: [],
            irrelevantScores,
        };
    }

    const hasMustFiles = [...grades.values()].some((grade) => grade === 2);
    const targetGrade = hasMustFiles ? 2 : 1;
    const targets = [...grades].filter(([, grade]) => grade >= targetGrade).map(([path]) => path);
    const top5 = new Set(ranked.slice(0, RECALL_DEPTH).map((file) => file.path));
    const recallAt5 = targets.filter((path) => top5.has(path)).length / targets.length;

    const firstIndex = ranked.findIndex((file) => grades.has(file.path));
    const firstRelevantRank = firstIndex === -1 ? null : firstIndex + 1;
    const targetScores = ranked
        .filter((file) => (grades.get(file.path) ?? 0) >= targetGrade)
        .map((file) => file.score);

    return {
        isHitAt1: firstRelevantRank === 1,
        recallAt5,
        reciprocalRank: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
        ndcgAt10: computeNdcg(ranked, grades),
        firstRelevantRank,
        topScore,
        bestRelevantScore: targetScores.length > 0 ? Math.max(...targetScores) : null,
        relevantScores: ranked.filter((file) => grades.has(file.path)).map((file) => file.score),
        irrelevantScores,
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
        mrr: mean((entry) => entry.reciprocalRank ?? 0),
        ndcgAt10: mean((entry) => entry.ndcgAt10 ?? 0),
    };
}

/**
 * Computes the 10th / 50th / 90th percentile (nearest rank) of a score list.
 *
 * @param scores - Any scores.
 * @returns The percentiles, `null` values for an empty list.
 */
export function percentiles(scores: readonly number[]): ScorePercentiles {
    if (scores.length === 0) {
        return { count: 0, p10: null, p50: null, p90: null };
    }
    const sorted = [...scores].sort((a, b) => a - b);
    const at = (quantile: number): number =>
        sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))];
    return { count: sorted.length, p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}

/**
 * Probability that a random relevant score beats a random irrelevant one (ROC AUC, ties count
 * half). 1.0 means a single global threshold could separate them perfectly, 0.5 means chance.
 *
 * @param relevantScores - Scores that should pass a threshold.
 * @param irrelevantScores - Scores that should not.
 * @returns The AUC in [0, 1], `null` when either list is empty.
 */
export function separationAuc(
    relevantScores: readonly number[],
    irrelevantScores: readonly number[],
): number | null {
    if (relevantScores.length === 0 || irrelevantScores.length === 0) {
        return null;
    }
    let wins = 0;
    for (const relevant of relevantScores) {
        for (const irrelevant of irrelevantScores) {
            if (relevant > irrelevant) {
                wins += 1;
            } else if (relevant === irrelevant) {
                wins += 0.5;
            }
        }
    }
    return wins / (relevantScores.length * irrelevantScores.length);
}

/**
 * Sweeps score floors and reports what each would keep or suppress.
 *
 * @param metrics - Case metrics of one run (positive and negative cases).
 * @param thresholds - Score floors to evaluate.
 * @returns One row per threshold.
 */
export function sweepThresholds(
    metrics: readonly CaseMetrics[],
    thresholds: readonly number[],
): ThresholdRow[] {
    const positives = metrics.filter((entry) => entry.isHitAt1 !== null);
    const negatives = metrics.filter((entry) => entry.isHitAt1 === null);
    const irrelevant = positives.flatMap((entry) => entry.irrelevantScores);
    const share = (count: number, total: number): number => (total === 0 ? 0 : count / total);
    return thresholds.map((threshold) => ({
        threshold,
        relevantKept: share(
            positives.filter(
                (entry) => entry.bestRelevantScore !== null && entry.bestRelevantScore > threshold,
            ).length,
            positives.length,
        ),
        irrelevantKept: share(
            irrelevant.filter((score) => score > threshold).length,
            irrelevant.length,
        ),
        negativesSuppressed: share(
            negatives.filter((entry) => entry.topScore === null || entry.topScore <= threshold)
                .length,
            negatives.length,
        ),
    }));
}
