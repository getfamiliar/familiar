import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
    DuplicateIdempotencyKeyError,
    type EmitHandle,
    type Logger,
    type NewEvent,
} from "@getfamiliar/shared";
import {
    emitRepairs,
    emitReviews,
    lintWiki,
    renderRepairPrompt,
    runLintPass,
} from "./WikiMaintenance.js";

/** A logger that drops everything. */
const silentLog: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => silentLog,
};

/**
 * Fake `ctx.events.emit` that records events and rejects a repeated idempotency key, like the bus.
 *
 * @returns The emit function and the recorded events.
 */
function fakeEmit(): { emit: (event: NewEvent) => Promise<EmitHandle>; events: NewEvent[] } {
    const events: NewEvent[] = [];
    const keys = new Set<string>();
    const emit = async (event: NewEvent): Promise<EmitHandle> => {
        const key = event.idempotencyKey ?? "";
        if (keys.has(key)) {
            throw new DuplicateIdempotencyKeyError(key);
        }
        keys.add(key);
        events.push(event);
        return { id: String(events.length), settled: Promise.resolve("done") } as EmitHandle;
    };
    return { emit, events };
}

describe("wiki maintenance", () => {
    let workspaceDir: string;

    before(() => {
        workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-memory-maintenance-"));
        mkdirSync(path.join(workspaceDir, "wiki", "people"), { recursive: true });
        writeFileSync(
            path.join(workspaceDir, "wiki", "people", "alice.md"),
            "---\ncategories: [work]\n---\n# Alice\n\nColleague.\n\n- 2026-07-12: kickoff\n",
        );
        writeFileSync(
            path.join(workspaceDir, "wiki", "people", "bob.md"),
            "---\nnotes: x\n---\n# Bob\n\nNeighbour.\n\n- 12.07.2026: party\n- 03/04/2026: call\n",
        );
        writeFileSync(
            path.join(workspaceDir, "wiki", "people", "carla.md"),
            "# Carla\n\nFriend.\n\n- Juli 2026: trip\n",
        );
    });

    after(() => {
        rmSync(workspaceDir, { recursive: true, force: true });
    });

    it("separates date fixes from problems left for the handler", async () => {
        const { fixes, flagged } = await lintWiki(workspaceDir);
        assert.deepEqual(
            fixes.map((fix) => [fix.path, fix.replacements.map((r) => `${r.from} → ${r.to}`)]),
            [
                ["wiki/people/bob.md", ["12.07.2026 → 2026-07-12"]],
                ["wiki/people/carla.md", ["Juli 2026 → 2026-07"]],
            ],
        );
        assert.deepEqual(
            flagged.map((file) => file.path),
            ["wiki/people/bob.md"],
        );
        assert.equal(
            renderRepairPrompt(flagged[0]),
            "path: wiki/people/bob.md\n\nProblems found by the linter:\n" +
                "- line 2 (frontmatter-key): unknown frontmatter key `notes` — only `categories` and `review_at` are allowed; move its content into the body\n" +
                '- line 9 (non-iso-date): "03/04/2026" is not an ISO date — day and month order is ambiguous, decide from the context',
        );
    });

    it("rewrites dates between a snapshot and a fix commit, and hands the rest over once", async () => {
        const { emit, events } = fakeEmit();
        const commits: [readonly string[], string][] = [];
        const commit = async (paths: readonly string[], message: string) => {
            commits.push([paths, message.split("\n")[0]]);
            return "abc1234";
        };
        const summary = await runLintPass(workspaceDir, emit, commit, silentLog);
        assert.deepEqual(summary.applied, {
            files: ["wiki/people/bob.md", "wiki/people/carla.md"],
            dates: 2,
            skipped: [],
            commitId: "abc1234",
        });
        assert.deepEqual(commits, [
            [
                ["wiki/people/bob.md", "wiki/people/carla.md"],
                "memory lint: snapshot before rewriting dates to ISO",
            ],
            [
                ["wiki/people/bob.md", "wiki/people/carla.md"],
                "memory lint: 2 date(s) rewritten to ISO in 2 wiki file(s)",
            ],
        ]);
        assert.equal(
            readFileSync(path.join(workspaceDir, "wiki", "people", "carla.md"), "utf8"),
            "# Carla\n\nFriend.\n\n- 2026-07: trip\n",
        );
        assert.deepEqual(
            events.map((event) => [event.topic, event.payload]),
            [
                [
                    "skills:memory:repair",
                    {
                        path: "wiki/people/bob.md",
                        problems: [
                            {
                                lineNo: 2,
                                rule: "frontmatter-key",
                                message:
                                    "unknown frontmatter key `notes` — only `categories` and `review_at` are allowed; move its content into the body",
                            },
                            {
                                lineNo: 9,
                                rule: "non-iso-date",
                                message:
                                    '"03/04/2026" is not an ISO date — day and month order is ambiguous, decide from the context',
                            },
                        ],
                    },
                ],
            ],
        );
        // Second pass: nothing to rewrite, the unchanged broken file is not handed over again.
        const again = await runLintPass(workspaceDir, emit, commit, silentLog);
        assert.equal(again.applied.dates, 0);
        assert.deepEqual(again.handOver, { emitted: 0, earlier: 1, failed: 0 });
        assert.equal(commits.length, 2);
    });

    it("hands unchanged content over once", async () => {
        const { emit } = fakeEmit();
        const { flagged } = await lintWiki(workspaceDir);
        assert.deepEqual(await emitRepairs(flagged, emit, silentLog), {
            emitted: 1,
            earlier: 0,
            failed: 0,
        });
        assert.deepEqual(await emitRepairs(flagged, emit, silentLog), {
            emitted: 0,
            earlier: 1,
            failed: 0,
        });
    });

    it("reviews a file once per review_at value", async () => {
        const { emit, events } = fakeEmit();
        const due = [{ path: "wiki/threads/sale.md", reviewAt: "2026-11-10" }];
        await emitReviews(due, emit, silentLog);
        await emitReviews(due, emit, silentLog);
        await emitReviews([{ ...due[0], reviewAt: "2026-12-01" }], emit, silentLog);
        assert.deepEqual(
            events.map((event) => [event.topic, event.prompt]),
            [
                ["skills:memory:review", "path: wiki/threads/sale.md\nreview_at: 2026-11-10"],
                ["skills:memory:review", "path: wiki/threads/sale.md\nreview_at: 2026-12-01"],
            ],
        );
    });
});
