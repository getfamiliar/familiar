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
import type { DreamCandidate } from "./WikiDream.js";
import type { WikiIndex } from "./WikiIndex.js";
import {
    emitRepairs,
    emitReviews,
    lintWiki,
    type PassDeps,
    planDreams,
    renderRepairPrompt,
    runDedupPass,
    runDreamPass,
    runLintPass,
    runSplitPass,
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

/** A fake run: what the handler does to the workspace, and its reply. */
type FakeRun = (event: NewEvent) => string;

/**
 * Fake `ctx.events.emit` whose `settled` runs `onRun` first, like a handler run that edits files.
 *
 * @param onRun - The fake handler.
 * @returns The emit function and the recorded events.
 */
function fakeRunningEmit(onRun: FakeRun): {
    emit: (event: NewEvent) => Promise<EmitHandle>;
    events: NewEvent[];
} {
    const events: NewEvent[] = [];
    const emit = async (event: NewEvent): Promise<EmitHandle> => {
        events.push(event);
        return { id: String(events.length), settled: Promise.resolve().then(() => onRun(event)) };
    };
    return { emit, events };
}

/**
 * Fake wiki index: titles from a map, `dedup_pairs` in memory.
 *
 * @param titles - Path → title of the indexed files.
 * @returns The index and the pair table.
 */
function fakeIndex(titles: ReadonlyMap<string, string>): {
    index: WikiIndex;
    pairs: Map<string, { pathA: string; pathB: string; sizeA: number; sizeB: number }>;
} {
    const pairs = new Map<string, { pathA: string; pathB: string; sizeA: number; sizeB: number }>();
    const query = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
        if (sql.includes("SELECT path_a")) {
            return [...pairs.values()];
        }
        if (sql.includes("DELETE FROM memory.dedup_pairs")) {
            pairs.delete(`${params[0]}\n${params[1]}`);
            return [];
        }
        if (sql.includes("INSERT INTO memory.dedup_pairs")) {
            const [pathA, pathB, sizeA, sizeB] = params as [string, string, number, number];
            pairs.set(`${pathA}\n${pathB}`, { pathA, pathB, sizeA, sizeB });
            return [];
        }
        throw new Error(`unexpected SQL: ${sql}`);
    };
    const index = {
        schema: "memory",
        db: { query },
        listFolderEntries: async (prefix: string) =>
            [...titles.entries()]
                .filter(([p]) => p.startsWith(`${prefix}/`))
                .map(([p, title]) => ({ path: p, title, description: "" })),
    } as unknown as WikiIndex;
    return { index, pairs };
}

/**
 * Pass deps on a workspace with a recording commit.
 *
 * @param workspaceDir - Workspace.
 * @param index - Index.
 * @param emit - Emission.
 * @param commits - Receives every commit message.
 * @returns The deps.
 */
function passDeps(
    workspaceDir: string,
    index: WikiIndex,
    emit: (event: NewEvent) => Promise<EmitHandle>,
    commits: string[],
): PassDeps {
    return {
        workspaceDir,
        index,
        emit,
        commitDirectory: async (dir, message) => {
            commits.push(`${dir}: ${message.split("\n")[0]}`);
            return String(commits.length);
        },
        log: silentLog,
        maxFileBytes: 2000,
        timezone: "UTC",
        shouldStop: () => false,
    };
}

describe("split pass", () => {
    it("hands every oversized file over in turn and cuts what is still too big", async () => {
        const workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-memory-split-pass-"));
        try {
            const threads = path.join(workspaceDir, "wiki", "threads");
            mkdirSync(threads, { recursive: true });
            const body = (heading: string): string =>
                `${heading}\n\n${"- a fact worth keeping\n".repeat(60)}`;
            writeFileSync(
                path.join(threads, "log.md"),
                `# Log\n\nA log.\n\n${body("## A")}\n${body("## B")}\n${body("## C")}`,
            );
            writeFileSync(
                path.join(threads, "stubborn.md"),
                `# Stubborn\n\nToo big.\n\n${body("## A")}\n${body("## B")}`,
            );
            const { emit, events } = fakeRunningEmit((event) => {
                const target = String((event.payload as { path: string }).path);
                if (target.endsWith("log.md")) {
                    writeFileSync(path.join(workspaceDir, target), "# Log\n\nCondensed.\n");
                    return "condensed wiki/threads/log.md";
                }
                return "noop";
            });
            const commits: string[] = [];
            const summary = await runSplitPass(
                passDeps(workspaceDir, fakeIndex(new Map()).index, emit, commits),
            );

            assert.deepEqual(
                events.map((event) => [event.topic, (event.payload as { path: string }).path]),
                [
                    ["skills:memory:split", "wiki/threads/log.md"],
                    ["skills:memory:split", "wiki/threads/stubborn.md"],
                ],
            );
            assert.deepEqual(
                summary.outcomes.map((outcome) => [outcome.path, outcome.harnessSecondPath]),
                [
                    ["wiki/threads/log.md", undefined],
                    ["wiki/threads/stubborn.md", "wiki/threads/stubborn-2.md"],
                ],
            );
            assert.match(
                readFileSync(path.join(threads, "stubborn-2.md"), "utf8"),
                /^# Stubborn \(2\)/,
            );
            assert.deepEqual(commits, [
                "wiki: memory split: snapshot before handling 2 file(s) over 2000 bytes",
                "wiki: memory split: 2 oversized file(s) handled, 1 cut by the harness",
            ]);
        } finally {
            rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    it("starts at most maxRuns split runs", async () => {
        const workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-memory-split-pass-"));
        try {
            const threads = path.join(workspaceDir, "wiki", "threads");
            mkdirSync(threads, { recursive: true });
            for (const slug of ["a", "b", "c"]) {
                writeFileSync(
                    path.join(threads, `${slug}.md`),
                    `# ${slug}\n\nBig.\n\n## One\n\n${"- fact\n".repeat(400)}\n## Two\n\n${"- fact\n".repeat(400)}`,
                );
            }
            const { emit, events } = fakeRunningEmit(() => "noop");
            const summary = await runSplitPass({
                ...passDeps(workspaceDir, fakeIndex(new Map()).index, emit, []),
                maxRuns: 2,
            });
            assert.equal(events.length, 2);
            assert.equal(summary.outcomes.length, 2);
        } finally {
            rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    it("commits nothing when no file is too big", async () => {
        const workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-memory-split-pass-"));
        try {
            mkdirSync(path.join(workspaceDir, "wiki"), { recursive: true });
            writeFileSync(path.join(workspaceDir, "wiki", "small.md"), "# Small\n");
            const commits: string[] = [];
            const { emit, events } = fakeRunningEmit(() => "");
            await runSplitPass(passDeps(workspaceDir, fakeIndex(new Map()).index, emit, commits));
            assert.equal(events.length, 0);
            assert.deepEqual(commits, []);
        } finally {
            rmSync(workspaceDir, { recursive: true, force: true });
        }
    });
});

describe("dedup pass", () => {
    it("scans each folder, runs new groups once and remembers their pairs", async () => {
        const workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-memory-dedup-pass-"));
        try {
            const people = path.join(workspaceDir, "wiki", "people");
            mkdirSync(people, { recursive: true });
            mkdirSync(path.join(workspaceDir, "wiki", "self"), { recursive: true });
            for (const slug of ["udo", "udo-sperling", "alice", "bob"]) {
                writeFileSync(path.join(people, `${slug}.md`), `# ${slug}\n\nPerson.\n`);
            }
            writeFileSync(path.join(workspaceDir, "wiki", "self", "only.md"), "# Only\n");
            const titles = new Map(
                ["udo", "udo-sperling", "alice", "bob"].map((slug) => [
                    `wiki/people/${slug}.md`,
                    slug,
                ]),
            );
            const { index, pairs } = fakeIndex(titles);
            const { emit, events } = fakeRunningEmit((event) => {
                if (event.topic === "skills:memory:dedup-scan") {
                    return "wiki/people/udo.md, wiki/people/udo-sperling.md\nwiki/people/alice.md, wiki/people/bob.md";
                }
                const paths = (event.payload as { paths: string[] }).paths;
                if (paths.includes("wiki/people/udo.md")) {
                    rmSync(path.join(people, "udo.md"));
                    return "merged wiki/people/udo.md into wiki/people/udo-sperling.md";
                }
                return "different people — left as they are";
            });
            const commits: string[] = [];
            const first = await runDedupPass(passDeps(workspaceDir, index, emit, commits));

            assert.deepEqual(
                events.map((event) => event.topic),
                [
                    "skills:memory:dedup-scan",
                    "skills:memory:deduplicate",
                    "skills:memory:deduplicate",
                ],
            );
            assert.match(events[0].prompt ?? "", /folder: wiki\/people/);
            assert.ok(events[1].prompt?.includes('<file path="wiki/people/udo.md">'));
            assert.deepEqual(
                first.outcomes.map((outcome) => outcome.recordedPairs),
                [0, 1],
            );
            assert.deepEqual([...pairs.keys()], ["wiki/people/alice.md\nwiki/people/bob.md"]);
            assert.equal(commits.length, 2);

            // Next week: the scan reports alice/bob again — already handled, no run, no commit.
            events.length = 0;
            commits.length = 0;
            const second = await runDedupPass(passDeps(workspaceDir, index, emit, commits));
            assert.equal(second.knownGroups, 1);
            assert.deepEqual(
                events.map((event) => event.topic),
                ["skills:memory:dedup-scan"],
            );
            assert.deepEqual(commits, []);

            // bob grows by more than 20 % and 500 bytes: the pair is forgotten and runs again.
            writeFileSync(
                path.join(people, "bob.md"),
                `# bob\n\nPerson.\n\n${"- fact\n".repeat(100)}`,
            );
            events.length = 0;
            const third = await runDedupPass(passDeps(workspaceDir, index, emit, commits));
            assert.equal(third.prunedPairs, 1);
            assert.deepEqual(
                events.map((event) => event.topic),
                ["skills:memory:dedup-scan", "skills:memory:deduplicate"],
            );
        } finally {
            rmSync(workspaceDir, { recursive: true, force: true });
        }
    });
});

describe("dream pass", () => {
    /**
     * Fake index with the dream tables in memory.
     *
     * @param candidates - Rows of `files`.
     * @returns The index and the recorded dreams.
     */
    function fakeDreamIndex(candidates: DreamCandidate[]): {
        index: WikiIndex;
        dreams: {
            path: string;
            eventId: string;
            criterion: string;
            summary: string;
            dreamedAt: Date;
        }[];
        files: DreamCandidate[];
    } {
        const files = [...candidates];
        const dreams: {
            path: string;
            eventId: string;
            criterion: string;
            summary: string;
            dreamedAt: Date;
        }[] = [];
        const query = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
            if (sql.includes('size_bytes AS "sizeBytes"')) {
                return files;
            }
            if (sql.includes("max(dreamed_at)")) {
                const times = files.flatMap((f) => (f.dreamedAt ? [f.dreamedAt.getTime()] : []));
                return [{ last: times.length > 0 ? new Date(Math.max(...times)) : null }];
            }
            if (sql.includes("FROM memory.dreams WHERE dreamed_at >=")) {
                return dreams.filter((d) => d.dreamedAt >= (params[0] as Date));
            }
            if (sql.includes("DELETE FROM memory.dreams")) {
                return [];
            }
            if (sql.includes("INSERT INTO memory.dreams")) {
                const [p, eventId, criterion, summary] = params as string[];
                dreams.push({ path: p, eventId, criterion, summary, dreamedAt: new Date() });
                return [];
            }
            if (sql.includes("UPDATE memory.files SET dreamed_at")) {
                const i = files.findIndex((f) => f.path === params[0]);
                files[i] = { ...files[i], dreamedAt: new Date(), dreamedSize: params[1] as number };
                return [];
            }
            throw new Error(`unexpected SQL: ${sql}`);
        };
        return {
            index: { schema: "memory", db: { query } } as unknown as WikiIndex,
            dreams,
            files,
        };
    }

    it("dreams the picked files in turn, records successes only and commits with event ids", async () => {
        const workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-memory-dream-pass-"));
        try {
            const people = path.join(workspaceDir, "wiki", "people");
            mkdirSync(people, { recursive: true });
            for (const slug of ["anna", "ben", "carla"]) {
                writeFileSync(path.join(people, `${slug}.md`), `# ${slug}\n\nPerson.\n`);
            }
            const old = new Date("2026-01-01T00:00:00Z");
            const { index, dreams, files } = fakeDreamIndex(
                ["anna", "ben", "carla"].map((slug, i) => ({
                    path: `wiki/people/${slug}.md`,
                    sizeBytes: 20,
                    modifiedAt: new Date(old.getTime() + i * 1000),
                    firstSeenAt: null,
                    dreamedAt: null,
                    dreamedSize: null,
                })),
            );
            const events: NewEvent[] = [];
            const emit = async (event: NewEvent): Promise<EmitHandle> => {
                events.push(event);
                const target = (event.payload as { path: string }).path;
                const settled = target.endsWith("ben.md")
                    ? Promise.reject(new Error("model unavailable"))
                    : Promise.resolve(`Condensed ${target}.\nLinked two related files.`);
                settled.catch(() => {});
                return { id: `ev${events.length}`, settled };
            };
            const commits: string[] = [];
            const deps = {
                ...passDeps(workspaceDir, index, emit, []),
                commitDirectory: async (_dir: string, message: string) => {
                    commits.push(message);
                    return String(commits.length);
                },
                dream: {
                    schedule: "every day at 05:00",
                    counts: { changed: 0, hot: 0, cold: 0, oldest: 3, random: 0 },
                    lockDays: 7,
                },
                summarizeReads: async () => [],
                readWindowDays: 14,
            };
            const summary = await runDreamPass(deps);

            assert.deepEqual(
                events.map((event) => (event.payload as { path: string }).path),
                ["wiki/people/anna.md", "wiki/people/ben.md", "wiki/people/carla.md"],
            );
            assert.match(events[0].prompt ?? "", /selected because: oldest — never dreamed/);
            assert.deepEqual(
                dreams.map((dream) => [dream.path, dream.eventId]),
                [
                    ["wiki/people/anna.md", "ev1"],
                    ["wiki/people/carla.md", "ev3"],
                ],
            );
            assert.equal(files.find((f) => f.path === "wiki/people/anna.md")?.dreamedSize, 16);
            assert.equal(summary.outcomes.length, 3);
            assert.equal(commits.length, 2);
            assert.match(commits[0], /^memory dream: snapshot before dreaming 3 file\(s\)/);
            assert.match(commits[1], /^memory dream: 2 of 3 file\(s\) dreamed/);
            assert.match(
                commits[1],
                /- wiki\/people\/anna\.md \(oldest: never dreamed\) — event ev1: Condensed wiki\/people\/anna\.md\./,
            );
            assert.match(
                commits[1],
                /wiki\/people\/ben\.md .* — event ev2: failed: model unavailable/,
            );

            // The dreamed files are locked now; only the failed one can come up again.
            const plan = await planDreams(deps);
            assert.deepEqual(
                plan.selections.map((selection) => selection.path),
                ["wiki/people/ben.md"],
            );
            assert.deepEqual(plan.locked, ["wiki/people/anna.md", "wiki/people/carla.md"]);
        } finally {
            rmSync(workspaceDir, { recursive: true, force: true });
        }
    });
});
