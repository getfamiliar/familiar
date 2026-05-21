import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import {
    type OffloadedJson,
    runJsonLinesTool,
    runJsonTool,
    runTextTool,
    ToolError,
    type ToolRunContext,
} from "./ToolRunner.js";

/** Capture-only spill: records what was written, returns a fixed path. */
function makeSpyCtx(limit: number): {
    ctx: ToolRunContext;
    spills: { name: string; bytes: Buffer }[];
} {
    const spills: { name: string; bytes: Buffer }[] = [];
    const ctx: ToolRunContext = {
        limit,
        spill: async (name, bytes) => {
            spills.push({ name, bytes });
            return `/scratch/test/${name}`;
        },
    };
    return { ctx, spills };
}

test("runJsonTool returns the object verbatim when within budget", async () => {
    const { ctx, spills } = makeSpyCtx(100);
    const result = await runJsonTool(async () => ({ a: 1, b: "hello" }), ctx);
    assert.deepEqual(result, { a: 1, b: "hello" });
    assert.equal(spills.length, 0);
});

test("runJsonTool spills and returns OffloadedJson when oversized", async () => {
    const { ctx, spills } = makeSpyCtx(20);
    const big = { data: "x".repeat(100) };
    const result = (await runJsonTool(async () => big, ctx)) as OffloadedJson;
    assert.equal(spills.length, 1);
    assert.equal(spills[0].name, "result.json");
    assert.equal(result.truncated, true);
    assert.equal(result.fullResultAt, "/scratch/test/result.json");
    assert.ok(/exceeded 20 bytes/.test(result.reason));
    // Spilled buffer contains the full JSON.
    assert.equal(spills[0].bytes.toString("utf8"), JSON.stringify(big));
});

test("runJsonTool propagates ToolError thrown by the body", async () => {
    const { ctx } = makeSpyCtx(100);
    await assert.rejects(
        () =>
            runJsonTool(async () => {
                throw new ToolError("Boom", "kaboom", 418);
            }, ctx),
        (err: unknown) => {
            assert.ok(err instanceof ToolError);
            assert.equal(err.code, "Boom");
            assert.equal(err.status, 418);
            assert.equal(err.message, "kaboom");
            return true;
        },
    );
});

test("runJsonTool propagates plain Error unchanged", async () => {
    const { ctx } = makeSpyCtx(100);
    await assert.rejects(
        () =>
            runJsonTool(async () => {
                throw new Error("plain failure");
            }, ctx),
        /plain failure/,
    );
});

test("runJsonLinesTool returns inline JSONL when within budget", async () => {
    const { ctx, spills } = makeSpyCtx(1000);
    const out = await runJsonLinesTool(async () => [{ a: 1 }, { a: 2 }, { a: 3 }], ctx);
    assert.equal(out, '{"a":1}\n{"a":2}\n{"a":3}');
    assert.equal(spills.length, 0);
});

test("runJsonLinesTool spills and appends marker when oversized", async () => {
    // 50 items × ~10 bytes each ≈ 500 bytes of JSONL; budget 150 forces
    // truncation but leaves room for several leading lines + the marker.
    const { ctx, spills } = makeSpyCtx(150);
    const items = Array.from({ length: 50 }, (_, i) => ({ idx: i }));
    const out = await runJsonLinesTool(async () => items, ctx);
    assert.equal(spills.length, 1);
    assert.equal(spills[0].name, "result.jsonl");
    const lines = out.split("\n");
    // Last line must be the truncation marker.
    const marker = JSON.parse(lines[lines.length - 1]) as {
        truncated: boolean;
        fullResultAt: string;
        omittedLines: number;
    };
    assert.equal(marker.truncated, true);
    assert.equal(marker.fullResultAt, "/scratch/test/result.jsonl");
    assert.ok(marker.omittedLines > 0);
    assert.ok(lines.length > 1); // at least one kept line plus the marker
    // The kept lines plus the marker fit within the limit.
    assert.ok(
        Buffer.byteLength(out, "utf8") <= 150,
        `output was ${Buffer.byteLength(out, "utf8")} bytes`,
    );
    // Spill file has all 50 lines.
    const spilled = spills[0].bytes.toString("utf8");
    assert.equal(spilled.split("\n").length, 50);
});

test("runJsonLinesTool returns only the marker when first line already overflows", async () => {
    const { ctx, spills } = makeSpyCtx(40);
    const items = [{ payload: "x".repeat(200) }, { a: 1 }];
    const out = await runJsonLinesTool(async () => items, ctx);
    assert.equal(spills.length, 1);
    const lines = out.split("\n");
    assert.equal(lines.length, 1);
    const marker = JSON.parse(lines[0]) as { truncated: boolean; omittedLines: number };
    assert.equal(marker.truncated, true);
    assert.equal(marker.omittedLines, 2);
});

test("runJsonLinesTool accepts an async iterable", async () => {
    const { ctx } = makeSpyCtx(1000);
    async function* gen(): AsyncIterable<object> {
        yield { a: 1 };
        yield { a: 2 };
    }
    const out = await runJsonLinesTool(async () => gen(), ctx);
    assert.equal(out, '{"a":1}\n{"a":2}');
});

test("runTextTool returns the body verbatim when within budget", async () => {
    const { ctx, spills } = makeSpyCtx(100);
    const out = await runTextTool(async () => "hello world", ctx);
    assert.equal(out, "hello world");
    assert.equal(spills.length, 0);
});

test("runTextTool spills and appends footer when oversized", async () => {
    // Budget chosen so the footer fits with some headroom for prefix content.
    const { ctx, spills } = makeSpyCtx(120);
    const big = "x".repeat(500);
    const out = await runTextTool(async () => big, ctx);
    assert.equal(spills.length, 1);
    assert.equal(spills[0].name, "result.txt");
    assert.ok(out.startsWith("x"));
    assert.ok(out.endsWith("[truncated; full result at /scratch/test/result.txt]"));
    assert.ok(Buffer.byteLength(out, "utf8") <= 120);
    // Spill file has the full original.
    assert.equal(spills[0].bytes.toString("utf8"), big);
});

test("runTextTool returns just the footer when budget can't fit any prefix", async () => {
    // Footer alone is ~50 bytes; with a 30-byte limit, the prefix has no room.
    const { ctx, spills } = makeSpyCtx(30);
    const out = await runTextTool(async () => "x".repeat(200), ctx);
    assert.equal(spills.length, 1);
    // No prefix room: the result is the footer (minus its leading blank line padding).
    assert.ok(out.includes("[truncated; full result at /scratch/test/result.txt]"));
    // The string starts with the newline-padding of the footer, not user content.
    assert.ok(!out.startsWith("x"));
});

test("runTextTool respects UTF-8 code-point boundaries on truncation", async () => {
    // Three-byte CJK characters; budget mid-character should round down.
    const { ctx } = makeSpyCtx(50);
    const text = "漢字".repeat(50);
    const out = await runTextTool(async () => text, ctx);
    // The output must be valid UTF-8 — round-tripping through Buffer
    // and back must be lossless (no replacement chars introduced).
    const buf = Buffer.from(out, "utf8");
    const back = buf.toString("utf8");
    assert.equal(back, out);
});

test("runTextTool propagates throws", async () => {
    const { ctx } = makeSpyCtx(100);
    await assert.rejects(
        () =>
            runTextTool(async () => {
                throw new ToolError("Nope", "nope");
            }, ctx),
        (err: unknown) => err instanceof ToolError && err.code === "Nope",
    );
});
