import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    type DreamCandidate,
    type DreamCounts,
    type DreamReadStats,
    type DreamSelectionInput,
    selectDreams,
} from "./WikiDream.js";

const LAST_PASS = new Date("2026-11-10T05:00:00Z");

/**
 * A candidate with defaults: 1000 bytes, modified long ago, never dreamed, seen before dreaming.
 *
 * @param path - Path.
 * @param fields - Overrides.
 * @returns The candidate.
 */
function file(path: string, fields: Partial<DreamCandidate> = {}): DreamCandidate {
    return {
        path,
        sizeBytes: 1000,
        modifiedAt: new Date("2026-01-01T00:00:00Z"),
        firstSeenAt: null,
        dreamedAt: null,
        dreamedSize: null,
        ...fields,
    };
}

/** Counts with every criterion off except the given ones. */
function only(counts: Partial<DreamCounts>): DreamCounts {
    return { changed: 0, hot: 0, cold: 0, oldest: 0, random: 0, ...counts };
}

/**
 * Selection input with defaults.
 *
 * @param candidates - Files.
 * @param counts - Counts.
 * @param extra - Overrides.
 * @returns The input.
 */
function input(
    candidates: readonly DreamCandidate[],
    counts: DreamCounts,
    extra: Partial<DreamSelectionInput> = {},
): DreamSelectionInput {
    return {
        candidates,
        reads: new Map(),
        locked: new Set(),
        counts,
        lastPassAt: LAST_PASS,
        readWindowDays: 14,
        random: () => 0,
        ...extra,
    };
}

/** `path:criterion` of each selection. */
function picked(selection: ReturnType<typeof selectDreams>): string[] {
    return selection.map((s) => `${s.path}:${s.criterion}`);
}

describe("selectDreams", () => {
    it("changed: new files first, then by growth since the last dream", () => {
        const after = new Date("2026-11-10T12:00:00Z");
        const selection = selectDreams(
            input(
                [
                    file("wiki/a.md", {
                        modifiedAt: after,
                        dreamedAt: new Date("2026-11-01T00:00:00Z"),
                        dreamedSize: 900,
                        sizeBytes: 1000,
                    }),
                    file("wiki/b.md", {
                        modifiedAt: after,
                        dreamedAt: new Date("2026-11-01T00:00:00Z"),
                        dreamedSize: 500,
                        sizeBytes: 3000,
                    }),
                    file("wiki/new.md", { modifiedAt: after, firstSeenAt: after, sizeBytes: 10 }),
                    file("wiki/untouched.md"),
                ],
                only({ changed: 3 }),
            ),
        );
        assert.deepEqual(picked(selection), [
            "wiki/new.md:changed",
            "wiki/b.md:changed",
            "wiki/a.md:changed",
        ]);
        assert.equal(selection[0].reason, "new file");
        assert.equal(selection[1].reason, "+2500 bytes since the last dream on 2026-11-01");
    });

    it("changed needs a change after the file's own dream", () => {
        const selection = selectDreams(
            input(
                [
                    file("wiki/dreamed-after.md", {
                        modifiedAt: new Date("2026-11-10T12:00:00Z"),
                        dreamedAt: new Date("2026-11-10T13:00:00Z"),
                        dreamedSize: 1000,
                    }),
                ],
                only({ changed: 3 }),
            ),
        );
        assert.deepEqual(selection, []);
    });

    it("hot: most reading runs first, files never read left out", () => {
        const reads = new Map<string, DreamReadStats>([
            ["wiki/a.md", { readingRuns: 2, lastReadAt: new Date("2026-11-09T00:00:00Z") }],
            ["wiki/b.md", { readingRuns: 7, lastReadAt: new Date("2026-11-08T00:00:00Z") }],
        ]);
        const selection = selectDreams(
            input([file("wiki/a.md"), file("wiki/b.md"), file("wiki/c.md")], only({ hot: 5 }), {
                reads,
            }),
        );
        assert.deepEqual(picked(selection), ["wiki/b.md:hot", "wiki/a.md:hot"]);
        assert.equal(selection[0].reason, "read by 7 run(s) in the last 14 days");
    });

    it("cold: longest neither modified nor read", () => {
        const reads = new Map<string, DreamReadStats>([
            [
                "wiki/old-but-read.md",
                { readingRuns: 1, lastReadAt: new Date("2026-11-09T00:00:00Z") },
            ],
        ]);
        const selection = selectDreams(
            input(
                [
                    file("wiki/old-but-read.md", { modifiedAt: new Date("2025-01-01T00:00:00Z") }),
                    file("wiki/older.md", { modifiedAt: new Date("2025-06-01T00:00:00Z") }),
                    file("wiki/recent.md", { modifiedAt: new Date("2026-10-01T00:00:00Z") }),
                ],
                only({ cold: 2 }),
                { reads },
            ),
        );
        assert.deepEqual(picked(selection), ["wiki/older.md:cold", "wiki/recent.md:cold"]);
        assert.equal(selection[0].reason, "not changed or read since 2025-06-01");
    });

    it("oldest: never dreamed first, then the longest ago", () => {
        const selection = selectDreams(
            input(
                [
                    file("wiki/dreamed-long-ago.md", {
                        dreamedAt: new Date("2026-01-01T00:00:00Z"),
                    }),
                    file("wiki/dreamed-recently.md", {
                        dreamedAt: new Date("2026-10-01T00:00:00Z"),
                    }),
                    file("wiki/never.md"),
                ],
                only({ oldest: 2 }),
            ),
        );
        assert.deepEqual(picked(selection), [
            "wiki/never.md:oldest",
            "wiki/dreamed-long-ago.md:oldest",
        ]);
    });

    it("picks every file once, skips locked files and fills the criteria in order", () => {
        const after = new Date("2026-11-10T12:00:00Z");
        const reads = new Map<string, DreamReadStats>([
            ["wiki/changed.md", { readingRuns: 9, lastReadAt: after }],
            ["wiki/read.md", { readingRuns: 1, lastReadAt: after }],
        ]);
        const selection = selectDreams(
            input(
                [
                    file("wiki/changed.md", { modifiedAt: after }),
                    file("wiki/read.md"),
                    file("wiki/locked.md", { modifiedAt: after }),
                    file("wiki/rest-1.md"),
                    file("wiki/rest-2.md"),
                ],
                { changed: 3, hot: 2, cold: 1, oldest: 1, random: 1 },
                { reads, locked: new Set(["wiki/locked.md"]) },
            ),
        );
        const paths = selection.map((s) => s.path);
        assert.equal(new Set(paths).size, paths.length);
        assert.ok(!paths.includes("wiki/locked.md"));
        assert.deepEqual(picked(selection).slice(0, 2), [
            "wiki/changed.md:changed",
            "wiki/read.md:hot",
        ]);
        assert.equal(selection.length, 4);
    });

    it("random draws uniformly from what is left", () => {
        const candidates = ["a", "b", "c", "d"].map((slug) => file(`wiki/${slug}.md`));
        const first = selectDreams(input(candidates, only({ random: 1 }), { random: () => 0 }));
        const last = selectDreams(input(candidates, only({ random: 1 }), { random: () => 0.999 }));
        assert.equal(first.length, 1);
        assert.equal(first[0].criterion, "random");
        assert.notEqual(first[0].path, last[0].path);
    });
});
