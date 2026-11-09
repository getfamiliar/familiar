import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { aggregateMetrics, type RankedFile, scoreCase } from "./EvalMetrics.js";

/**
 * Builds a ranked list from paths.
 *
 * @param paths - Paths, best first.
 * @returns The ranked files.
 */
function ranked(...paths: string[]): RankedFile[] {
    return paths.map((path) => ({ path, matchedTermCount: 1 }));
}

describe("scoreCase", () => {
    it("scores a top-ranked must-have file as a perfect hit", () => {
        const metrics = scoreCase(
            ranked("a.md", "b.md", "x.md"),
            new Map([
                ["a.md", 2],
                ["b.md", 1],
            ]),
        );
        assert.equal(metrics.isHitAt1, true);
        assert.equal(metrics.recallAt5, 1);
        assert.equal(metrics.reciprocalRank, 1);
        assert.equal(metrics.ndcgAt10, 1);
        assert.equal(metrics.resultCount, 3);
    });

    it("counts a grade-1 file as the first relevant rank but not for must-have recall", () => {
        const metrics = scoreCase(
            ranked("x.md", "b.md", "y.md"),
            new Map([
                ["a.md", 2],
                ["b.md", 1],
            ]),
        );
        assert.equal(metrics.isHitAt1, false);
        assert.equal(metrics.firstRelevantRank, 2);
        assert.equal(metrics.reciprocalRank, 0.5);
        assert.equal(metrics.recallAt5, 0);
    });

    it("tells recall at 5 and at 10 apart", () => {
        const metrics = scoreCase(
            ranked("1.md", "2.md", "3.md", "4.md", "5.md", "6.md", "a.md"),
            new Map([["a.md", 2]]),
        );
        assert.equal(metrics.recallAt5, 0);
        assert.equal(metrics.recallAt10, 1);
        assert.equal(metrics.firstRelevantRank, 7);
    });

    it("falls back to grade-1 files when a case has no must-have file", () => {
        const metrics = scoreCase(ranked("b.md"), new Map([["b.md", 1]]));
        assert.equal(metrics.recallAt5, 1);
    });

    it("reports only the result count for negative cases", () => {
        const metrics = scoreCase(ranked("x.md", "y.md"), new Map());
        assert.equal(metrics.isHitAt1, null);
        assert.equal(metrics.recallAt5, null);
        assert.equal(metrics.resultCount, 2);
    });
});

describe("aggregateMetrics", () => {
    it("averages positive cases and skips negative ones", () => {
        const aggregate = aggregateMetrics([
            scoreCase(ranked("a.md"), new Map([["a.md", 2]])),
            scoreCase(ranked("x.md", "a.md"), new Map([["a.md", 2]])),
            scoreCase(ranked("x.md"), new Map()),
        ]);
        assert.equal(aggregate.caseCount, 2);
        assert.equal(aggregate.hitAt1, 0.5);
        assert.equal(aggregate.recallAt5, 1);
        assert.equal(aggregate.mrr, 0.75);
    });
});
