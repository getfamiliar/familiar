import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HandlerFile } from "./HandlerFile.js";
import { buildPrompt, buildPromptParts, PromptTemplateMissingError } from "./PromptBuilder.js";

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

/** The PROMPT.md shipped with the canonical workspace template. */
const SHIPPED_PROMPT_TEMPLATE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../data/workspace-template/PROMPT.md",
);

describe("buildPromptParts", () => {
    let workspaceRoot: string;
    let previousWorkspaceRoot: string;

    before(() => {
        previousWorkspaceRoot = HandlerFile.getWorkspaceRoot();
        workspaceRoot = mkdtempSync(path.join(tmpdir(), "familiar-prompt-test-"));
        copyFileSync(SHIPPED_PROMPT_TEMPLATE, path.join(workspaceRoot, "PROMPT.md"));
        writeFileSync(path.join(workspaceRoot, "SOUL.md"), "I am the soul.\n", "utf8");
        writeFileSync(path.join(workspaceRoot, "CONTEXT.md"), "I am the context.\n", "utf8");
        mkdirSync(path.join(workspaceRoot, "skills", "listfiles"), { recursive: true });
        writeFileSync(
            path.join(workspaceRoot, "skills", "listfiles", "SKILL.md"),
            "---\ndescription: How to keep lists in files.\n---\nbody\n",
            "utf8",
        );
        mkdirSync(path.join(workspaceRoot, "prompts"), { recursive: true });
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

    /** Build parts for `handler` with fixed run facts and no plugin access. */
    function build(handler: HandlerFile, privileged = false) {
        return buildPromptParts({
            handler,
            topic: "chat:telegram",
            privileged,
            toolNames: ["send_chat", "bash"],
            eventId: "event-without-scratch",
            plugins: null,
        });
    }

    it("renders the shipped PROMPT.md into the familiar sections", async () => {
        const parts = await build(loadHandler("handler-full.md", "Do the thing.\n"));
        assert.match(parts.system, /^# Identity\n\nI am the soul\./m);
        assert.match(parts.system, /^# Context\n\nI am the context\./m);
        assert.match(parts.system, /^# Handler\n\nDo the thing\./m);
        assert.match(parts.system, /^- `listfiles`: How to keep lists in files\.$/m);
        assert.match(parts.system, /^# Available tools\n\n- send_chat\n- bash$/m);
        assert.match(parts.system, /^## The bash tool$/m);
        assert.doesNotMatch(parts.system, /^# Runtime$/m);
        assert.match(parts.userHead, /^# Runtime$/m);
        assert.match(parts.userHead, /^- Event topic: `chat:telegram`$/m);
        assert.match(parts.userHead, /^- privileged: no$/m);
        assert.equal(parts.templatePath, "PROMPT.md");
        assert.deepEqual(parts.warnings, []);
    });

    it("keeps the system prompt byte-identical across runs (cacheable prefix)", async () => {
        const handler = loadHandler("handler-stable.md", "Do the thing.\n");
        const first = await build(handler, false);
        const second = await build(handler, true);
        assert.equal(first.system, second.system);
        assert.notEqual(first.userHead, second.userHead);
    });

    it("redacts includes in the audit variant only", async () => {
        const parts = await build(loadHandler("handler-redacted.md", "Do the thing.\n"));
        assert.match(parts.redacted.system, /^# Identity\n\n<content of file SOUL\.md>$/m);
        assert.equal(parts.redacted.system.includes("I am the soul."), false);
        assert.match(parts.redacted.system, /^# Handler\n\nDo the thing\./m);
    });

    it("renders only the handler body for systemPrompt: none", async () => {
        const parts = await build(
            loadHandler("handler-none.md", "---\nsystemPrompt: none\n---\nDo the thing.\n"),
        );
        assert.equal(parts.system, "Do the thing.");
        assert.equal(parts.userHead, "");
        assert.equal(parts.templatePath, null);
    });

    it("uses a custom template path", async () => {
        writeFileSync(
            path.join(workspaceRoot, "prompts", "minimal.md"),
            "{HANDLER_CONTENT}\n\n{CACHE_MARKER}\n\nTopic: {EVENT_TOPIC}",
            "utf8",
        );
        const parts = await build(
            loadHandler(
                "handler-custom.md",
                "---\nsystemPrompt: prompts/minimal.md\n---\nDo the thing.\n",
            ),
        );
        assert.equal(parts.system, "Do the thing.");
        assert.equal(parts.userHead, "Topic: chat:telegram");
    });

    it("throws when the selected template is missing", async () => {
        const handler = loadHandler(
            "handler-missing.md",
            "---\nsystemPrompt: prompts/nope.md\n---\nDo the thing.\n",
        );
        await assert.rejects(build(handler), PromptTemplateMissingError);
    });

    it("warns about unknown and misplaced per-run placeholders", async () => {
        writeFileSync(
            path.join(workspaceRoot, "prompts", "bad.md"),
            "{CURRENT_TIME} {MYSTERY}\n{CACHE_MARKER}\n",
            "utf8",
        );
        const parts = await build(
            loadHandler("handler-bad.md", "---\nsystemPrompt: prompts/bad.md\n---\nx\n"),
        );
        assert.match(parts.system, /\{MYSTERY\}/);
        assert.ok(parts.warnings.some((w) => /unknown placeholder \{MYSTERY\}/.test(w)));
        assert.ok(parts.warnings.some((w) => /\{CURRENT_TIME\} before \{CACHE_MARKER\}/.test(w)));
    });

    it("does not expand placeholders smuggled in through the handler's tools", async () => {
        const parts = await buildPromptParts({
            handler: loadHandler("handler-inject.md", "Do the thing.\n"),
            topic: "chat:telegram",
            privileged: false,
            toolNames: ["{SOUL.md}"],
            eventId: "event-without-scratch",
            plugins: null,
        });
        assert.match(parts.system, /^- \{SOUL\.md\}$/m);
    });
});
