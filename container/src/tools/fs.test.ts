import { strict as assert } from "node:assert";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentRunRow, ToolRunContext } from "@getfamiliar/shared";
import { HandlerFile } from "../HandlerFile.js";
import { buildFsTools } from "./fs.js";

interface SpillCapture {
    readonly calls: Array<{ name: string; bytes: number }>;
}

/**
 * Build a {@link ToolRunContext} suitable for unit-testing fs_read.
 * `spill` records calls but never writes anything to disk so a test
 * accidentally producing a spill is easy to assert against.
 */
function buildTestCtx(limit: number, capture: SpillCapture): ToolRunContext {
    return {
        limit,
        spill: async (suggestedName, contents) => {
            capture.calls.push({ name: suggestedName, bytes: contents.byteLength });
            return `/scratch/test/${suggestedName}-stub`;
        },
    };
}

/** Dummy parent row — fs_read doesn't use it but the factory signature requires one. */
const PARENT_ROW = { id: "test-parent" } as unknown as AgentRunRow;

/** Locate fs_read inside the assembled fs tool set. */
function fileReadTool(ctx: ToolRunContext) {
    const tools = buildFsTools(PARENT_ROW, ctx);
    const t = tools.fs_read;
    if (!t?.execute) {
        throw new Error("fs_read tool not found / has no execute");
    }
    return t.execute;
}

/**
 * Invoke fs_read with the typed input shape; cast through the SDK's
 * (input, options) signature without faking a real ToolCallOptions.
 */
async function readFile(
    ctx: ToolRunContext,
    input: { path: string; offset?: number; limit?: number },
): Promise<string> {
    const exec = fileReadTool(ctx);
    // biome-ignore lint/suspicious/noExplicitAny: SDK's options type isn't needed for these tests.
    const result = await (exec as any)(input, {} as any);
    return result as string;
}

describe("fs_read — paginated text mode", () => {
    let workspaceDir: string;

    before(() => {
        workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-fs-test-"));
        HandlerFile.setWorkspaceRoot(workspaceDir);
    });

    after(() => {
        rmSync(workspaceDir, { recursive: true, force: true });
    });

    it("small file: returns full content with non-truncated header", async () => {
        const body = "hello world\nline two\n";
        await fs.writeFile(path.join(workspaceDir, "small.md"), body, "utf8");
        const capture: SpillCapture = { calls: [] };
        const ctx = buildTestCtx(10_000, capture);

        const out = await readFile(ctx, { path: "small.md" });

        const totalBytes = Buffer.byteLength(body, "utf8");
        assert.equal(out, `<file: small.md, bytes 1-${totalBytes} of ${totalBytes}>\n${body}`);
        assert.equal(capture.calls.length, 0);
    });

    it("large file with default limit: truncated, fits ctx.limit, no spill", async () => {
        // 50 KB of ASCII so byte count == char count for simple math.
        const body = "x".repeat(50_000);
        await fs.writeFile(path.join(workspaceDir, "big.txt"), body, "utf8");
        const capture: SpillCapture = { calls: [] };
        const limit = 5_000;
        const ctx = buildTestCtx(limit, capture);

        const out = await readFile(ctx, { path: "big.txt" });

        assert.ok(out.startsWith("<file: big.txt, bytes 1-"));
        assert.ok(out.includes(" of 50000, truncated>"));
        assert.ok(
            Buffer.byteLength(out, "utf8") <= limit,
            `response ${Buffer.byteLength(out, "utf8")} > ctx.limit ${limit}`,
        );
        assert.equal(capture.calls.length, 0, "fs_read must not trigger the offload spill");
    });

    it("continuation: offset = previousLastByte + 1 returns the next chunk; concat reproduces file", async () => {
        const body = "x".repeat(50_000);
        await fs.writeFile(path.join(workspaceDir, "big2.txt"), body, "utf8");
        const capture: SpillCapture = { calls: [] };
        const ctx = buildTestCtx(5_000, capture);

        const reassembled: string[] = [];
        let offset = 1;
        let hasMore = true;
        let safety = 100; // guard against an infinite loop in the test itself
        while (hasMore && safety-- > 0) {
            const out = await readFile(ctx, { path: "big2.txt", offset });
            const newlineIdx = out.indexOf("\n");
            const header = out.slice(0, newlineIdx);
            const content = out.slice(newlineIdx + 1);
            reassembled.push(content);

            const match = header.match(/bytes (\d+)-(\d+) of (\d+)(, truncated)?>$/);
            assert.ok(match, `unexpected header: ${header}`);
            const lastByte = Number(match[2]);
            hasMore = Boolean(match[4]);
            offset = lastByte + 1;
        }
        assert.ok(safety > 0, "pagination loop did not terminate");
        assert.equal(reassembled.join(""), body);
        assert.equal(capture.calls.length, 0);
    });

    it("explicit small limit: honored, body ≤ limit bytes", async () => {
        const body = "a".repeat(10_000);
        await fs.writeFile(path.join(workspaceDir, "small-limit.txt"), body, "utf8");
        const ctx = buildTestCtx(10_000, { calls: [] });

        const out = await readFile(ctx, { path: "small-limit.txt", limit: 100 });
        const newlineIdx = out.indexOf("\n");
        const content = out.slice(newlineIdx + 1);
        assert.ok(content.length <= 100, `body ${content.length} > 100`);
        assert.ok(out.includes("of 10000, truncated>"));
    });

    it("UTF-8 boundary: a 4-byte emoji straddling the cut is kept whole on the next call", async () => {
        // 90 bytes of ASCII + 4-byte emoji (U+1F642) + 4 more ASCII bytes.
        // With limit=4 (after header reserve = 1), we'd read exactly 1
        // ascii char. Instead pick a more realistic scenario: ctx.limit
        // large enough for the header plus ~90 bytes of content.
        const prefix = "x".repeat(90);
        const emoji = "🙂"; // 4 UTF-8 bytes
        const suffix = "abcd";
        const body = prefix + emoji + suffix;
        const total = Buffer.byteLength(body, "utf8");
        await fs.writeFile(path.join(workspaceDir, "emoji.txt"), body, "utf8");

        const ctx = buildTestCtx(200 + 91, { calls: [] }); // content budget = 91 bytes (prefix + 1)
        // 91 bytes of content would include the full prefix (90) and try
        // to add 1 byte of the 4-byte emoji. truncateUtf8 must back off
        // to the 90-byte boundary so the emoji is kept whole on the next read.

        const first = await readFile(ctx, { path: "emoji.txt" });
        const firstBody = first.slice(first.indexOf("\n") + 1);
        assert.equal(firstBody, prefix, "first chunk must stop at the code-point boundary");

        const firstHeader = first.slice(0, first.indexOf("\n"));
        const m = firstHeader.match(/bytes 1-(\d+) of /);
        assert.ok(m);
        const lastByte = Number(m[1]);
        assert.equal(lastByte, 90);

        // Read the rest. Use a roomy ctx so we don't need to paginate.
        const wideCtx = buildTestCtx(10_000, { calls: [] });
        const second = await readFile(wideCtx, { path: "emoji.txt", offset: lastByte + 1 });
        const secondBody = second.slice(second.indexOf("\n") + 1);
        assert.equal(secondBody, emoji + suffix);
        assert.ok(second.includes(`of ${total}>`)); // not truncated
    });

    it("empty file", async () => {
        await fs.writeFile(path.join(workspaceDir, "empty.txt"), "", "utf8");
        const ctx = buildTestCtx(10_000, { calls: [] });
        const out = await readFile(ctx, { path: "empty.txt" });
        assert.equal(out, "<file: empty.txt, empty>\n");
    });

    it("offset past end of file", async () => {
        await fs.writeFile(path.join(workspaceDir, "short.txt"), "hello", "utf8");
        const ctx = buildTestCtx(10_000, { calls: [] });
        const out = await readFile(ctx, { path: "short.txt", offset: 99 });
        assert.equal(out, "<file: short.txt, offset 99 past end of 5 bytes>\n");
    });

    it("loop defeat: huge file at tiny ctx.limit never triggers ctx.spill", async () => {
        // Mirror the original bug shape: offload-style file far exceeding
        // ctx.limit. Reading it must produce a bounded result with no spill.
        const body = "z".repeat(80_000);
        await fs.writeFile(path.join(workspaceDir, "huge.txt"), body, "utf8");
        const capture: SpillCapture = { calls: [] };
        const limit = 4_000;
        const ctx = buildTestCtx(limit, capture);

        const out = await readFile(ctx, { path: "huge.txt" });
        assert.ok(Buffer.byteLength(out, "utf8") <= limit);
        assert.ok(!out.includes('truncated":true'), "no JSON sentinel from offload wrapper");
        assert.equal(capture.calls.length, 0, "ctx.spill must not be called");
    });

    it("long workspace path does not blow the header reserve", async () => {
        const deepDir = path.join(workspaceDir, "a".repeat(50), "b".repeat(50));
        await fs.mkdir(deepDir, { recursive: true });
        const fileName = "deep.txt";
        const relPath = path.join("a".repeat(50), "b".repeat(50), fileName);
        const body = "y".repeat(5_000);
        await fs.writeFile(path.join(deepDir, fileName), body, "utf8");

        const limit = 2_000;
        const ctx = buildTestCtx(limit, { calls: [] });
        const out = await readFile(ctx, { path: relPath });
        assert.ok(
            Buffer.byteLength(out, "utf8") <= limit,
            `response ${Buffer.byteLength(out, "utf8")} > ctx.limit ${limit}`,
        );
        assert.ok(out.startsWith(`<file: ${relPath}, bytes 1-`));
    });

    it("ENOENT throws FileNotFound; EISDIR throws IsADirectory", async () => {
        const ctx = buildTestCtx(10_000, { calls: [] });
        await assert.rejects(() => readFile(ctx, { path: "does-not-exist.md" }), /file not found/i);

        await fs.mkdir(path.join(workspaceDir, "a-dir"), { recursive: true });
        await assert.rejects(() => readFile(ctx, { path: "a-dir" }), /directory, not a file/i);
    });
});

/** Invoke fs_write with the given parent-row privilege. */
async function callFsWrite(
    ctx: ToolRunContext,
    parent: AgentRunRow,
    input: { path: string; content: string },
): Promise<{ bytes: number }> {
    const exec = buildFsTools(parent, ctx).fs_write?.execute;
    if (!exec) {
        throw new Error("fs_write tool not found");
    }
    // biome-ignore lint/suspicious/noExplicitAny: SDK options type isn't needed here.
    return (await (exec as any)(input, {} as any)) as { bytes: number };
}

describe("fs_write — privilege gate (writablePaths + scratch only)", () => {
    let workspaceDir: string;
    const nonPrivileged = { id: "np", privileged: false } as unknown as AgentRunRow;
    const privileged = { id: "p", privileged: true } as unknown as AgentRunRow;

    before(() => {
        // No CORE_WRITABLE_PATHS in the test env → empty allowlist, so every
        // workspace path is protected. (Exercises the changed rule: a plain
        // non-.md write is now privileged too.)
        workspaceDir = mkdtempSync(path.join(tmpdir(), "familiar-fs-priv-"));
        HandlerFile.setWorkspaceRoot(workspaceDir);
    });

    after(() => {
        rmSync(workspaceDir, { recursive: true, force: true });
    });

    it("refuses ANY workspace write for a non-privileged run", async () => {
        const ctx = buildTestCtx(10_000, { calls: [] });
        // Both a plain data file and a markdown file are now off-limits.
        await assert.rejects(
            () => callFsWrite(ctx, nonPrivileged, { path: "data.json", content: "{}" }),
            /non-privileged/i,
        );
        await assert.rejects(
            () => callFsWrite(ctx, nonPrivileged, { path: "mail/x.md", content: "hi" }),
            /non-privileged/i,
        );
    });

    it("allows a privileged run and stamps the protected file mode (0o640)", async () => {
        const ctx = buildTestCtx(10_000, { calls: [] });
        const res = await callFsWrite(ctx, privileged, { path: "notes/handbook.md", content: "x" });
        assert.equal(res.bytes, 1);
        const mode = (await fs.stat(path.join(workspaceDir, "notes/handbook.md"))).mode & 0o777;
        assert.equal(mode, 0o640, `expected protected mode 0o640, got 0o${mode.toString(8)}`);
    });
});
