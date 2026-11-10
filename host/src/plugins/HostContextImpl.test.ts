import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ConfigService, Logger, NewEvent } from "@getfamiliar/shared";
import { HostContextImpl, type HostContextImplDeps, isUsableChannelId } from "./HostContextImpl.js";

describe("isUsableChannelId", () => {
    it("accepts a non-empty string", () => {
        assert.equal(isUsableChannelId("telegram"), true);
        assert.equal(isUsableChannelId(" "), true); // whitespace counts; we don't trim
        assert.equal(isUsableChannelId("cli"), true);
    });

    it("rejects an empty string", () => {
        assert.equal(isUsableChannelId(""), false);
    });

    it("rejects null and undefined", () => {
        assert.equal(isUsableChannelId(null), false);
        assert.equal(isUsableChannelId(undefined), false);
    });

    it("rejects booleans", () => {
        assert.equal(isUsableChannelId(false), false);
        assert.equal(isUsableChannelId(true), false);
    });

    it("rejects numbers (including 0)", () => {
        assert.equal(isUsableChannelId(0), false);
        assert.equal(isUsableChannelId(42), false);
        assert.equal(isUsableChannelId(Number.NaN), false);
    });

    it("rejects objects and arrays", () => {
        assert.equal(isUsableChannelId({}), false);
        assert.equal(isUsableChannelId({ id: "telegram" }), false);
        assert.equal(isUsableChannelId(["telegram"]), false);
    });

    it("acts as a TypeScript type guard", () => {
        const candidate: unknown = "telegram";
        if (isUsableChannelId(candidate)) {
            // Compile-time assertion: inside this branch, `candidate`
            // is narrowed to `string`. The `.toUpperCase()` would not
            // typecheck against `unknown`.
            assert.equal(candidate.toUpperCase(), "TELEGRAM");
        } else {
            assert.fail("string should pass the guard");
        }
    });
});

describe("HostContextImpl ctx.mail.emitMailEvent", () => {
    const mailEvent: NewEvent = {
        topic: "mail:new:ms365",
        prompt: "A new e-mail was received",
        idempotencyKey: "mail:new:ms365:<abc@example.com>",
    };

    it("suppresses the event in dev mode when mail.emitEventsInDev is unset", async () => {
        const ctx = buildContext({ devMode: true, bools: {} });
        assert.equal(await ctx.mail.emitMailEvent(mailEvent), null);
    });

    it("delegates to the bus in dev mode when mail.emitEventsInDev is true", async () => {
        const ctx = buildContext({ devMode: true, bools: { "mail.emitEventsInDev": true } });
        await assert.rejects(ctx.mail.emitMailEvent(mailEvent), /reached the bus/);
    });

    it("delegates to the bus outside dev mode", async () => {
        const ctx = buildContext({ devMode: false, bools: {} });
        await assert.rejects(ctx.mail.emitMailEvent(mailEvent), /reached the bus/);
    });

    it("rejects non-mail topics", async () => {
        const ctx = buildContext({ devMode: false, bools: {} });
        await assert.rejects(
            ctx.mail.emitMailEvent({ ...mailEvent, topic: "calendar:new:ms365" }),
            /not a mail topic/,
        );
    });
});

/**
 * Build a context whose only live dependencies are config, logger and
 * the dev flag. `ensureConnection` throws a sentinel so a test can tell
 * "emission reached the bus" apart from "suppressed" without postgres.
 */
function buildContext(opts: { devMode: boolean; bools: Record<string, boolean> }): HostContextImpl {
    const config = {
        getBool: ((key: string, def?: unknown) =>
            opts.bools[key] ?? def) as ConfigService["getBool"],
    } as ConfigService;
    const noop = () => {};
    const log = { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
    const deps = {
        pluginId: "ms365",
        config,
        log,
        devMode: opts.devMode,
        ensureConnection: async () => {
            throw new Error("reached the bus");
        },
    } as unknown as HostContextImplDeps;
    return new HostContextImpl(deps);
}

describe("HostContextImpl ctx.scratch listing", () => {
    it("lists the regular top-level files and resolves basenames only", async () => {
        const scratchDir = mkdtempSync(path.join(tmpdir(), "familiar-scratch-"));
        try {
            const eventDir = path.join(scratchDir, "42");
            mkdirSync(path.join(eventDir, "nested"), { recursive: true });
            writeFileSync(path.join(eventDir, "report.pdf"), "pdf");
            writeFileSync(path.join(eventDir, ".result-abcd1234.json"), "{}");
            writeFileSync(path.join(eventDir, "nested", "deep.txt"), "x");
            const ctx = new HostContextImpl({
                pluginId: "web-chat",
                scratchDir,
            } as unknown as HostContextImplDeps);

            const files = await ctx.scratch.listFiles("42");
            assert.deepEqual(
                files.map((file) => [file.name, file.size]),
                [
                    [".result-abcd1234.json", 2],
                    ["report.pdf", 3],
                ],
            );
            assert.deepEqual(await ctx.scratch.listFiles("43"), []);
            assert.equal(
                ctx.scratch.resolveFile("42", "report.pdf"),
                path.join(eventDir, "report.pdf"),
            );
            assert.throws(() => ctx.scratch.resolveFile("42", "../x"), /basename/);
            assert.throws(() => ctx.scratch.resolveFile("../42", "x"), /numeric event id/);
            await assert.rejects(ctx.scratch.listFiles("4/2"), /numeric event id/);
        } finally {
            rmSync(scratchDir, { recursive: true, force: true });
        }
    });
});

describe("HostContextImpl ctx.database", () => {
    /**
     * Build a context whose connection is a fake pool recording every
     * statement; `failOn` makes the matching statement reject.
     *
     * @param failOn - SQL text that throws when executed.
     * @returns The context, the recorded statements and the release counter.
     */
    function buildDatabaseContext(failOn?: string): {
        ctx: HostContextImpl;
        statements: string[];
        releases: { count: number };
    } {
        const statements: string[] = [];
        const releases = { count: 0 };
        const run = async (sql: string) => {
            statements.push(sql);
            if (sql === failOn) {
                throw new Error(`failed: ${sql}`);
            }
            return { rows: [{ sql }] };
        };
        const pool = {
            query: run,
            connect: async () => ({
                query: run,
                release: () => {
                    releases.count += 1;
                },
            }),
        };
        const noop = () => {};
        const ctx = new HostContextImpl({
            pluginId: "memory",
            log: { debug: noop, info: noop, warn: noop, error: noop },
            ensureConnection: async () => ({ getPool: () => pool }),
        } as unknown as HostContextImplDeps);
        return { ctx, statements, releases };
    }

    it("returns the rows of a plain query", async () => {
        const { ctx } = buildDatabaseContext();
        assert.deepEqual(await ctx.database.query("SELECT 1"), [{ sql: "SELECT 1" }]);
    });

    it("commits a successful transaction and releases the client", async () => {
        const { ctx, statements, releases } = buildDatabaseContext();
        const result = await ctx.database.transaction(async (query) => {
            await query("INSERT 1");
            return "ok";
        });
        assert.equal(result, "ok");
        assert.deepEqual(statements, ["BEGIN", "INSERT 1", "COMMIT"]);
        assert.equal(releases.count, 1);
    });

    it("rolls back and rethrows when the work fails", async () => {
        const { ctx, statements, releases } = buildDatabaseContext("INSERT 1");
        await assert.rejects(
            ctx.database.transaction((query) => query("INSERT 1")),
            /failed: INSERT 1/,
        );
        assert.deepEqual(statements, ["BEGIN", "INSERT 1", "ROLLBACK"]);
        assert.equal(releases.count, 1);
    });
});

describe("HostContextImpl ctx.workspaceHistory.commitFiles", () => {
    /**
     * Build a context on a temp workspace with the given `core.autoUpdate`.
     *
     * @param workspaceDir - Temp workspace.
     * @param isAutoUpdateEnabled - Value of `core.autoUpdate`.
     * @returns The context.
     */
    function buildHistoryContext(
        workspaceDir: string,
        isAutoUpdateEnabled: boolean,
    ): HostContextImpl {
        const config = {
            getBool: ((key: string, def?: unknown) =>
                key === "core.autoUpdate" ? isAutoUpdateEnabled : def) as ConfigService["getBool"],
        } as ConfigService;
        return new HostContextImpl({
            pluginId: "memory",
            config,
            workspaceDir,
        } as unknown as HostContextImplDeps);
    }

    it("commits exactly the given paths and leaves other changes uncommitted", async () => {
        const workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-history-"));
        try {
            mkdirSync(path.join(workspaceDir, "wiki"));
            writeFileSync(path.join(workspaceDir, "wiki", "a.md"), "# A\n");
            writeFileSync(path.join(workspaceDir, "wiki", "b.md"), "# B\n");
            const ctx = buildHistoryContext(workspaceDir, true);

            const commitId = await ctx.workspaceHistory.commitFiles(["wiki/a.md"], "test: a");
            assert.match(commitId ?? "", /^[0-9a-f]{7}$/);
            assert.equal(await ctx.workspaceHistory.commitFiles(["wiki/a.md"], "again"), null);
            assert.notEqual(await ctx.workspaceHistory.commitFiles(["wiki/b.md"], "test: b"), null);
        } finally {
            rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    it("commits nothing when core.autoUpdate is false", async () => {
        const workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-history-"));
        try {
            writeFileSync(path.join(workspaceDir, "a.md"), "# A\n");
            const ctx = buildHistoryContext(workspaceDir, false);
            assert.equal(await ctx.workspaceHistory.commitFiles(["a.md"], "test"), null);
            assert.equal(existsSync(path.join(workspaceDir, ".git")), false);
        } finally {
            rmSync(workspaceDir, { recursive: true, force: true });
        }
    });
});
