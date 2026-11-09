import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    aggregateMetrics,
    percentiles,
    type RankedFile,
    scoreCase,
    separationAuc,
    sweepThresholds,
} from "./EvalMetrics.js";

/** Builds a ranked list from `[path, score]` pairs. */
function ranked(...entries: [string, number][]): RankedFile[] {
    return entries.map(([path, score]) => ({ path, score }));
}

describe("scoreCase", () => {
    it("scores a top-ranked must-have file as a perfect hit", () => {
        const metrics = scoreCase(
            ranked(["a.md", 0.9], ["b.md", 0.5], ["x.md", 0.4]),
            new Map([
                ["a.md", 2],
                ["b.md", 1],
            ]),
        );
        assert.equal(metrics.isHitAt1, true);
        assert.equal(metrics.recallAt5, 1);
        assert.equal(metrics.reciprocalRank, 1);
        assert.equal(metrics.ndcgAt10, 1);
        assert.equal(metrics.bestRelevantScore, 0.9);
        assert.deepEqual(metrics.irrelevantScores, [0.4]);
    });

    it("counts a grade-1 file as the first relevant rank but not for must-have recall", () => {
        const metrics = scoreCase(
            ranked(["x.md", 0.8], ["b.md", 0.7], ["y.md", 0.6]),
            new Map([
                ["a.md", 2],
                ["b.md", 1],
            ]),
        );
        assert.equal(metrics.isHitAt1, false);
        assert.equal(metrics.firstRelevantRank, 2);
        assert.equal(metrics.reciprocalRank, 0.5);
        assert.equal(metrics.recallAt5, 0);
        assert.equal(metrics.bestRelevantScore, null);
    });

    it("falls back to grade-1 files when a case has no must-have file", () => {
        const metrics = scoreCase(ranked(["b.md", 0.6]), new Map([["b.md", 1]]));
        assert.equal(metrics.recallAt5, 1);
        assert.equal(metrics.bestRelevantScore, 0.6);
    });

    it("reports only the top score for negative cases", () => {
        const metrics = scoreCase(ranked(["x.md", 0.7], ["y.md", 0.5]), new Map());
        assert.equal(metrics.isHitAt1, null);
        assert.equal(metrics.topScore, 0.7);
        assert.deepEqual(metrics.irrelevantScores, [0.7, 0.5]);
    });
});

describe("aggregateMetrics", () => {
    it("averages positive cases and skips negatives", () => {
        const hit = scoreCase(ranked(["a.md", 0.9]), new Map([["a.md", 2]]));
        const miss = scoreCase(ranked(["x.md", 0.9]), new Map([["a.md", 2]]));
        const negative = scoreCase(ranked(["x.md", 0.9]), new Map());
        const aggregate = aggregateMetrics([hit, miss, negative]);
        assert.equal(aggregate.caseCount, 2);
        assert.equal(aggregate.hitAt1, 0.5);
        assert.equal(aggregate.mrr, 0.5);
    });
});

describe("percentiles", () => {
    it("uses nearest-rank percentiles", () => {
        const stats = percentiles([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
        assert.deepEqual(stats, { count: 10, p10: 0.1, p50: 0.5, p90: 0.9 });
    });

    it("returns nulls for an empty list", () => {
        assert.deepEqual(percentiles([]), { count: 0, p10: null, p50: null, p90: null });
    });
});

describe("separationAuc", () => {
    it("is 1 for perfectly separated scores and 0.5 for identical ones", () => {
        assert.equal(separationAuc([0.8, 0.9], [0.1, 0.2]), 1);
        assert.equal(separationAuc([0.5], [0.5]), 0.5);
        assert.equal(separationAuc([], [0.5]), null);
    });
});

describe("sweepThresholds", () => {
    it("keeps files strictly above the floor and counts empty negatives", () => {
        const positive = scoreCase(ranked(["a.md", 0.6], ["x.md", 0.5]), new Map([["a.md", 2]]));
        const negative = scoreCase(ranked(["y.md", 0.55]), new Map());
        const [low, high] = sweepThresholds([positive, negative], [0.5, 0.6]);
        assert.deepEqual(low, {
            threshold: 0.5,
            relevantKept: 1,
            irrelevantKept: 0,
            negativesSuppressed: 0,
        });
        assert.deepEqual(high, {
            threshold: 0.6,
            relevantKept: 0,
            irrelevantKept: 0,
            negativesSuppressed: 1,
        });
    });
});
