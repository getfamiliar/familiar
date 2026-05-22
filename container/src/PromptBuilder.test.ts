import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { HandlerFile } from "./HandlerFile.js";
import { buildPrompt, buildSystemPrompt, formatRuntimeTime } from "./PromptBuilder.js";

/** Pull the JSON block out of a rendered prompt for shape assertions. */
function extractPayloadJson(rendered: string): string | null {
    const match = rendered.match(/```json\n([\s\S]*?)\n```/);
    return match === null ? null : (match[1] ?? null);
}

describe("buildPrompt — empty inputs", () => {
    it("returns empty string for null prompt and null payload", () => {
        assert.equal(buildPrompt(null, null), "");
    });

    it("returns empty string for empty prompt and empty object payload", () => {
        assert.equal(buildPrompt("   ", {}), "");
    });

    it("returns empty string for null prompt and undefined payload", () => {
        assert.equal(buildPrompt(null, undefined), "");
    });
});

describe("buildPrompt — prompt-only", () => {
    it("returns the run prompt verbatim when no payload", () => {
        assert.equal(buildPrompt("hello world", null), "hello world");
    });

    it("ignores empty/whitespace-only run prompts", () => {
        assert.equal(buildPrompt("", { a: 1 }), '# Payload\n\n```json\n{\n  "a": 1\n}\n```');
    });
});

describe("buildPrompt — payload rendering", () => {
    it("renders a simple object as a fenced JSON block under # Payload", () => {
        const out = buildPrompt(null, { text: "hi", count: 3 });
        assert.match(out, /^# Payload\n\n```json\n/);
        const json = extractPayloadJson(out);
        assert.equal(json, '{\n  "text": "hi",\n  "count": 3\n}');
    });

    it("places the run prompt before the payload when both are present", () => {
        const out = buildPrompt("the seed", { a: 1 });
        const promptIdx = out.indexOf("the seed");
        const payloadIdx = out.indexOf("# Payload");
        assert.equal(promptIdx >= 0 && payloadIdx > promptIdx, true);
    });

    it("renders nested objects recursively", () => {
        const out = buildPrompt(null, { whatsapp: { from: { name: "Anna" } } });
        const json = extractPayloadJson(out) ?? "";
        assert.match(json, /"whatsapp":/);
        assert.match(json, /"from":/);
        assert.match(json, /"name": "Anna"/);
    });

    it("renders arrays as JSON arrays", () => {
        const out = buildPrompt(null, { tags: ["a", "b", "c"] });
        const json = extractPayloadJson(out) ?? "";
        assert.match(json, /"tags": \[\n\s+"a",\n\s+"b",\n\s+"c"\n\s+\]/);
    });
});

describe("buildPrompt — key sanitization", () => {
    it("replaces non-ASCII characters in keys with `_`", () => {
        const out = buildPrompt(null, { "händel:🎉": "value" });
        const json = extractPayloadJson(out) ?? "";
        // ä is one byte → `_`; emoji 🎉 is multi-byte → multiple `_`s.
        assert.match(json, /"h_ndel:_+":/);
        assert.match(json, /"value"/);
    });

    it("sanitizes keys at every nesting level", () => {
        const out = buildPrompt(null, { "outer\n": { "inner\t": "v" } });
        const json = extractPayloadJson(out) ?? "";
        assert.match(json, /"outer_":/);
        assert.match(json, /"inner_":/);
    });

    it("caps very long keys", () => {
        const longKey = "k".repeat(500);
        const out = buildPrompt(null, { [longKey]: 1 });
        const json = extractPayloadJson(out) ?? "";
        // 64-char cap; key in JSON appears between quotes.
        const m = json.match(/"(k+)":/);
        assert.ok(m, "expected a key match");
        assert.equal((m?.[1] ?? "").length, 64);
    });

    it("substitutes `_` for an all-non-ASCII key (so it doesn't render as empty)", () => {
        const out = buildPrompt(null, { "🎉": "value" });
        const json = extractPayloadJson(out) ?? "";
        // Key sanitizes to `_` chars; never to an empty string.
        assert.match(json, /"_+":\s*"value"/);
    });
});

describe("buildPrompt — value truncation", () => {
    it("caps a long string value with the truncation marker", () => {
        // Length tuned to exceed MAX_VALUE_CHARS so the cap fires.
        // The exact constant lives in PromptBuilder.ts; keep this
        // comfortably above any reasonable value to stay green if
        // it's nudged up.
        const length = 12000;
        const long = "x".repeat(length);
        const out = buildPrompt(null, { body: long });
        const json = extractPayloadJson(out) ?? "";
        assert.match(json, new RegExp(`…\\[truncated, original ${length} chars\\]`));
        assert.equal(json.includes(long), false);
    });

    it("does not touch short values", () => {
        const out = buildPrompt(null, { body: "short" });
        assert.match(extractPayloadJson(out) ?? "", /"body": "short"/);
    });

    it("does not touch numeric / boolean / null values regardless of size", () => {
        const out = buildPrompt(null, { n: 12345678901234, b: false, x: null });
        const json = extractPayloadJson(out) ?? "";
        assert.match(json, /"n": 12345678901234/);
        assert.match(json, /"b": false/);
        assert.match(json, /"x": null/);
    });
});

describe("buildPrompt — total payload cap", () => {
    it("caps the rendered payload at MAX_PAYLOAD_CHARS with the truncation marker", () => {
        // Many small entries — sanitizer doesn't cap them
        // individually, but the assembled JSON exceeds the payload
        // cap. Tuned high so the test stays green if the cap is
        // nudged up later.
        const big: Record<string, string> = {};
        for (let i = 0; i < 5000; i++) {
            big[`key${i}`] = `value${i}`;
        }
        const out = buildPrompt(null, big);
        assert.match(out, /…\[truncated, original \d+ chars\]/);
    });
});

describe("formatRuntimeTime", () => {
    // 2026-05-19T16:43:12 UTC is Tuesday at 18:43:12 in Europe/Berlin
    // (DST in effect — UTC+2). Pinned UTC instant + explicit tz keeps
    // the test deterministic regardless of the container's system tz.
    const fixed = new Date("2026-05-19T16:43:12Z");

    it("renders weekday + ISO-shaped local time + IANA tz label", () => {
        const out = formatRuntimeTime(fixed, "Europe/Berlin");
        assert.equal(out, "Tuesday, 2026-05-19T18:43:12 in timezone Europe/Berlin");
    });

    it("respects a different timezone", () => {
        const out = formatRuntimeTime(fixed, "America/Los_Angeles");
        // 16:43 UTC → 09:43 PDT (UTC-7 in May).
        assert.equal(out, "Tuesday, 2026-05-19T09:43:12 in timezone America/Los_Angeles");
    });

    it("UTC round-trips the underlying instant", () => {
        const out = formatRuntimeTime(fixed, "UTC");
        assert.equal(out, "Tuesday, 2026-05-19T16:43:12 in timezone UTC");
    });
});

describe("buildSystemPrompt — systemPrompt mode", () => {
    let workspaceRoot: string;
    let previousWorkspaceRoot: string;

    before(() => {
        previousWorkspaceRoot = HandlerFile.getWorkspaceRoot();
        workspaceRoot = mkdtempSync(path.join(tmpdir(), "familiar-prompt-test-"));
        writeFileSync(path.join(workspaceRoot, "SOUL.md"), "I am the soul.\n", "utf8");
        writeFileSync(
            path.join(workspaceRoot, "ENVIRONMENT.md"),
            "I am the environment.\n",
            "utf8",
        );
        writeFileSync(path.join(workspaceRoot, "CONTEXT.md"), "I am the context.\n", "utf8");
        HandlerFile.setWorkspaceRoot(workspaceRoot);
    });

    after(() => {
        HandlerFile.setWorkspaceRoot(previousWorkspaceRoot);
        rmSync(workspaceRoot, { recursive: true, force: true });
    });

    /** Write a handler file under the temp workspace and load it back. */
    function loadHandler(relativePath: string, contents: string): HandlerFile {
        writeFileSync(path.join(workspaceRoot, relativePath), contents, "utf8");
        return HandlerFile.read(relativePath);
    }

    it("includes Identity / Environment / Context by default (full mode)", () => {
        const handler = loadHandler("handler-full.md", "Do the thing.\n");
        const prompt = buildSystemPrompt(handler, ["send_chat"], "test", false);
        assert.match(prompt, /^# Identity\n\nI am the soul\./m);
        assert.match(prompt, /^# Environment\n\nI am the environment\./m);
        assert.match(prompt, /^# Context\n\nI am the context\./m);
        assert.match(prompt, /^# Handler\n\nDo the thing\./m);
        assert.match(prompt, /^# Available tools$/m);
        assert.match(prompt, /^# Runtime$/m);
    });

    it("includes Identity but skips Environment / Context for only-soul", () => {
        const handler = loadHandler(
            "handler-only-soul.md",
            "---\nsystemPrompt: only-soul\n---\nDo the thing.\n",
        );
        const prompt = buildSystemPrompt(handler, ["send_chat"], "test", false);
        assert.match(prompt, /^# Identity\n\nI am the soul\./m);
        assert.doesNotMatch(prompt, /^# Environment$/m);
        assert.doesNotMatch(prompt, /^# Context$/m);
        assert.match(prompt, /^# Handler\n\nDo the thing\./m);
        assert.match(prompt, /^# Runtime$/m);
    });

    it("skips Identity / Environment / Context for none", () => {
        const handler = loadHandler(
            "handler-none.md",
            "---\nsystemPrompt: none\n---\nDo the thing.\n",
        );
        const prompt = buildSystemPrompt(handler, ["send_chat"], "test", false);
        assert.doesNotMatch(prompt, /^# Identity$/m);
        assert.doesNotMatch(prompt, /^# Environment$/m);
        assert.doesNotMatch(prompt, /^# Context$/m);
        assert.match(prompt, /^# Handler\n\nDo the thing\./m);
        assert.match(prompt, /^# Available tools$/m);
        assert.match(prompt, /^# Runtime$/m);
    });
});
