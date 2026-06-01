import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { HandlerFile } from "./HandlerFile.js";
import {
    buildPrompt,
    buildRuntimeContextBlock,
    buildSystemPrompt,
    formatRuntimeTime,
} from "./PromptBuilder.js";

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

    it("includes Identity / Context by default (full mode)", () => {
        const handler = loadHandler("handler-full.md", "Do the thing.\n");
        const { full: prompt } = buildSystemPrompt(handler, ["send_chat"]);
        assert.match(prompt, /^# Identity\n\nI am the soul\./m);
        assert.match(prompt, /^# Context\n\nI am the context\./m);
        assert.match(prompt, /^# Handler\n\nDo the thing\./m);
        assert.match(prompt, /^# Available tools$/m);
        // The dynamic `# Runtime` block lives in the user message now, not
        // the (cacheable) system prompt.
        assert.doesNotMatch(prompt, /^# Runtime$/m);
    });

    it("is byte-identical across repeated builds (a cacheable, static prefix)", () => {
        const handler = loadHandler("handler-stable.md", "Do the thing.\n");
        // No `new Date()` or other per-run input feeds the system prompt
        // anymore, so two builds of the same handler must match exactly —
        // the property that makes it cacheable.
        const first = buildSystemPrompt(handler, ["send_chat"]);
        const second = buildSystemPrompt(handler, ["send_chat"]);
        assert.equal(first.full, second.full);
        assert.equal(first.redacted, second.redacted);
    });

    it("includes Identity but skips Environment / Context for only-soul", () => {
        const handler = loadHandler(
            "handler-only-soul.md",
            "---\nsystemPrompt: only-soul\n---\nDo the thing.\n",
        );
        const { full: prompt } = buildSystemPrompt(handler, ["send_chat"]);
        assert.match(prompt, /^# Identity\n\nI am the soul\./m);
        assert.doesNotMatch(prompt, /^# Environment$/m);
        assert.doesNotMatch(prompt, /^# Context$/m);
        assert.match(prompt, /^# Handler\n\nDo the thing\./m);
        assert.doesNotMatch(prompt, /^# Runtime$/m);
    });

    it("skips Identity / Environment / Context for none", () => {
        const handler = loadHandler(
            "handler-none.md",
            "---\nsystemPrompt: none\n---\nDo the thing.\n",
        );
        const { full: prompt } = buildSystemPrompt(handler, ["send_chat"]);
        assert.doesNotMatch(prompt, /^# Identity$/m);
        assert.doesNotMatch(prompt, /^# Environment$/m);
        assert.doesNotMatch(prompt, /^# Context$/m);
        assert.match(prompt, /^# Handler\n\nDo the thing\./m);
        assert.match(prompt, /^# Available tools$/m);
        assert.doesNotMatch(prompt, /^# Runtime$/m);
    });
});

describe("buildSystemPrompt — skills section", () => {
    let workspaceRoot: string;
    let previousWorkspaceRoot: string;

    before(() => {
        previousWorkspaceRoot = HandlerFile.getWorkspaceRoot();
        workspaceRoot = mkdtempSync(path.join(tmpdir(), "familiar-skills-test-"));
        HandlerFile.setWorkspaceRoot(workspaceRoot);
    });

    after(() => {
        HandlerFile.setWorkspaceRoot(previousWorkspaceRoot);
        rmSync(workspaceRoot, { recursive: true, force: true });
    });

    /** Write a skill at `skills/<id>/SKILL.md` with the given source. */
    function writeSkill(id: string, source: string): void {
        const dir = path.join(workspaceRoot, "skills", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "SKILL.md"), source, "utf8");
    }

    /** Reset the skills/ directory between cases. */
    function resetSkills(): void {
        rmSync(path.join(workspaceRoot, "skills"), { recursive: true, force: true });
    }

    /** Build a throwaway handler under the temp workspace. */
    function loadHandler(relativePath: string, contents: string): HandlerFile {
        writeFileSync(path.join(workspaceRoot, relativePath), contents, "utf8");
        return HandlerFile.read(relativePath);
    }

    it("omits the section entirely when skills/ does not exist", async () => {
        resetSkills();
        const handler = loadHandler(
            "no-skills.md",
            "---\nsystemPrompt: none\n---\nDo the thing.\n",
        );
        const { full: prompt } = buildSystemPrompt(handler, ["send_chat"]);
        assert.doesNotMatch(prompt, /^# Available skills$/m);
    });

    it("renders (read) for a skill without tools and no marker when tools are set", async () => {
        resetSkills();
        writeSkill(
            "listfiles",
            "---\nname: listfiles\ndescription: How to keep lists in files.\n---\nbody\n",
        );
        writeSkill(
            "jira_issues",
            "---\nname: jira_issues\ndescription: Create and update Jira issues.\ntools: jira_create,jira_update\n---\nbody\n",
        );
        const handler = loadHandler(
            "with-skills.md",
            "---\nsystemPrompt: none\n---\nDo the thing.\n",
        );
        const { full: prompt } = buildSystemPrompt(handler, ["send_chat"]);
        assert.match(prompt, /^# Available skills$/m);
        assert.match(prompt, /^- `jira_issues`: Create and update Jira issues\.$/m);
        assert.match(prompt, /^- `listfiles` \(read\): How to keep lists in files\.$/m);
    });

    it("places the skills section before # Available tools", async () => {
        resetSkills();
        writeSkill(
            "listfiles",
            "---\nname: listfiles\ndescription: How to keep lists in files.\n---\nbody\n",
        );
        const handler = loadHandler(
            "order-skills.md",
            "---\nsystemPrompt: none\n---\nDo the thing.\n",
        );
        const { full: prompt } = buildSystemPrompt(handler, ["send_chat"]);
        const skillsIdx = prompt.indexOf("# Available skills");
        const toolsIdx = prompt.indexOf("# Available tools");
        assert.ok(skillsIdx >= 0 && toolsIdx >= 0);
        assert.ok(skillsIdx < toolsIdx, "skills section must appear before tools section");
    });

    it("skips entries that are malformed or non-compliant", async () => {
        resetSkills();
        // Valid one so the section still renders.
        writeSkill("good", "---\nname: good\ndescription: A real skill.\n---\nbody\n");
        // Missing SKILL.md.
        mkdirSync(path.join(workspaceRoot, "skills", "empty-folder"), { recursive: true });
        // Loose file directly under skills/ (not a folder).
        writeFileSync(path.join(workspaceRoot, "skills", "notafolder.md"), "loose\n", "utf8");
        // Malformed YAML frontmatter.
        writeSkill("malformed", "---\nname: malformed\ndescription: : : :\n  bad\n---\nbody\n");
        // No frontmatter at all.
        writeSkill("no-frontmatter", "# just a body, no frontmatter\n");
        // Frontmatter present but no description.
        writeSkill("no-desc", "---\nname: no-desc\n---\nbody\n");
        // Empty description.
        writeSkill("empty-desc", '---\nname: empty-desc\ndescription: "   "\n---\nbody\n');

        const handler = loadHandler(
            "robust-skills.md",
            "---\nsystemPrompt: none\n---\nDo the thing.\n",
        );
        const { full: prompt } = buildSystemPrompt(handler, ["send_chat"]);
        assert.match(prompt, /^- `good` \(read\): A real skill\.$/m);
        for (const id of [
            "empty-folder",
            "notafolder",
            "malformed",
            "no-frontmatter",
            "no-desc",
            "empty-desc",
        ]) {
            assert.doesNotMatch(
                prompt,
                new RegExp(`^- \`${id}\``, "m"),
                `expected skill "${id}" to be skipped`,
            );
        }
    });

    it("truncates descriptions longer than 256 chars with an ellipsis", async () => {
        resetSkills();
        const longDescription = "x".repeat(300);
        writeSkill("long", `---\nname: long\ndescription: ${longDescription}\n---\nbody\n`);
        const handler = loadHandler(
            "long-skill.md",
            "---\nsystemPrompt: none\n---\nDo the thing.\n",
        );
        const { full: prompt } = buildSystemPrompt(handler, ["send_chat"]);
        const bulletMatch = prompt.match(/^- `long` \(read\): (x+…)$/m);
        assert.ok(bulletMatch, "expected truncated bullet line");
        const rendered = bulletMatch?.[1] ?? "";
        assert.equal(rendered.length, 257, "256 x's plus the ellipsis");
    });

    it("renders skills sorted by id", async () => {
        resetSkills();
        writeSkill("zeta", "---\nname: zeta\ndescription: z.\n---\nbody\n");
        writeSkill("alpha", "---\nname: alpha\ndescription: a.\n---\nbody\n");
        writeSkill("mu", "---\nname: mu\ndescription: m.\n---\nbody\n");
        const handler = loadHandler(
            "sorted-skills.md",
            "---\nsystemPrompt: none\n---\nDo the thing.\n",
        );
        const { full: prompt } = buildSystemPrompt(handler, ["send_chat"]);
        const alphaIdx = prompt.indexOf("- `alpha`");
        const muIdx = prompt.indexOf("- `mu`");
        const zetaIdx = prompt.indexOf("- `zeta`");
        assert.ok(alphaIdx >= 0 && muIdx >= 0 && zetaIdx >= 0);
        assert.ok(alphaIdx < muIdx && muIdx < zetaIdx, "skills must be sorted by id");
    });
});

describe("buildSystemPrompt — redacted variant", () => {
    let workspaceRoot: string;
    let previousWorkspaceRoot: string;

    before(() => {
        previousWorkspaceRoot = HandlerFile.getWorkspaceRoot();
        workspaceRoot = mkdtempSync(path.join(tmpdir(), "familiar-redacted-test-"));
        writeFileSync(path.join(workspaceRoot, "SOUL.md"), "I am the soul.\n", "utf8");
        writeFileSync(path.join(workspaceRoot, "CONTEXT.md"), "I am the context.\n", "utf8");
        HandlerFile.setWorkspaceRoot(workspaceRoot);
    });

    after(() => {
        HandlerFile.setWorkspaceRoot(previousWorkspaceRoot);
        rmSync(workspaceRoot, { recursive: true, force: true });
    });

    function loadHandler(relativePath: string, contents: string): HandlerFile {
        writeFileSync(path.join(workspaceRoot, relativePath), contents, "utf8");
        return HandlerFile.read(relativePath);
    }

    it("swaps SOUL / CONTEXT bodies for placeholders in `redacted`", async () => {
        const handler = loadHandler("redacted-full.md", "Do the thing.\n");
        const { full, redacted } = buildSystemPrompt(handler, ["send_chat"]);
        // `full` keeps the framing-file bodies verbatim.
        assert.match(full, /^# Identity\n\nI am the soul\./m);
        assert.match(full, /^# Context\n\nI am the context\./m);
        // `redacted` swaps them for `<content of file …>` placeholders.
        assert.match(redacted, /^# Identity\n\n<content of file SOUL\.md>$/m);
        assert.match(redacted, /^# Context\n\n<content of file CONTEXT\.md>$/m);
        assert.equal(redacted.includes("I am the soul."), false);
        assert.equal(redacted.includes("I am the context."), false);
        // Everything else (handler body, tool list) is unchanged. The
        // `# Runtime` block no longer lives in the system prompt.
        assert.match(redacted, /^# Handler\n\nDo the thing\./m);
        assert.match(redacted, /^# Available tools$/m);
        assert.doesNotMatch(redacted, /^# Runtime$/m);
    });

    it("returns `redacted === full` when the handler excludes the framing files", async () => {
        const handler = loadHandler(
            "redacted-none.md",
            "---\nsystemPrompt: none\n---\nDo the thing.\n",
        );
        const { full, redacted } = buildSystemPrompt(handler, ["send_chat"]);
        assert.equal(redacted, full);
    });
});

describe("buildRuntimeContextBlock", () => {
    let workspaceRoot: string;
    let previousWorkspaceRoot: string;

    before(() => {
        previousWorkspaceRoot = HandlerFile.getWorkspaceRoot();
        workspaceRoot = mkdtempSync(path.join(tmpdir(), "familiar-runtime-test-"));
        writeFileSync(path.join(workspaceRoot, "SOUL.md"), "I am the soul.\n", "utf8");
        writeFileSync(path.join(workspaceRoot, "CONTEXT.md"), "I am the context.\n", "utf8");
        HandlerFile.setWorkspaceRoot(workspaceRoot);
    });

    after(() => {
        HandlerFile.setWorkspaceRoot(previousWorkspaceRoot);
        rmSync(workspaceRoot, { recursive: true, force: true });
    });

    function loadHandler(relativePath: string, contents: string): HandlerFile {
        writeFileSync(path.join(workspaceRoot, relativePath), contents, "utf8");
        return HandlerFile.read(relativePath);
    }

    it("renders the `# Runtime` section with topic and privileged flag", async () => {
        const handler = loadHandler("rt-full.md", "Do the thing.\n");
        const block = await buildRuntimeContextBlock(handler, "chat:telegram", true, null);
        assert.match(block, /^# Runtime$/m);
        assert.match(block, /^- Current time: /m);
        assert.match(block, /^- Event topic: `chat:telegram`$/m);
        assert.match(block, /^- privileged: yes, the prompt stems from the system owner$/m);
    });

    it("renders the non-privileged flag", async () => {
        const handler = loadHandler("rt-unpriv.md", "Do the thing.\n");
        const block = await buildRuntimeContextBlock(handler, "mail:new", false, null);
        assert.match(block, /^- privileged: no$/m);
    });

    it("always includes Runtime regardless of the handler's systemPrompt mode", async () => {
        const handler = loadHandler("rt-none.md", "---\nsystemPrompt: none\n---\nDo the thing.\n");
        const block = await buildRuntimeContextBlock(handler, "test", false, null);
        assert.match(block, /^# Runtime$/m);
    });

    it("contains only the dynamic block — no system-prompt sections", async () => {
        const handler = loadHandler("rt-isolation.md", "Do the thing.\n");
        const block = await buildRuntimeContextBlock(handler, "test", false, null);
        // These belong to the (static) system prompt, never the runtime block.
        assert.doesNotMatch(block, /^# Identity$/m);
        assert.doesNotMatch(block, /^# Context$/m);
        assert.doesNotMatch(block, /^# Handler$/m);
        assert.doesNotMatch(block, /^# Available tools$/m);
    });

    it("skips the plugin event-context fetch when eventContext is null", async () => {
        // A null eventContext must not attempt any network fetch — the
        // block is exactly the Runtime section, nothing appended.
        const handler = loadHandler("rt-nofetch.md", "Do the thing.\n");
        const block = await buildRuntimeContextBlock(handler, "test", false, null);
        assert.ok(block.startsWith("# Runtime\n\n"));
    });
});
