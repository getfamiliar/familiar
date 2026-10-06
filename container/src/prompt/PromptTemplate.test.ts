import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    isSafeIncludePath,
    type ParseTemplateOptions,
    parseTemplate,
    renderTemplate,
} from "./PromptTemplate.js";

/** Build parse options over an in-memory file map. */
function options(
    files: Record<string, string> = {},
    templateSources: Record<string, string> = {},
): ParseTemplateOptions {
    return {
        templateName: "PROMPT.md",
        readInclude: (relativePath) => files[relativePath] ?? null,
        templateSources,
    };
}

describe("parseTemplate / renderTemplate", () => {
    it("substitutes placeholders and leaves other braces untouched", () => {
        const parsed = parseTemplate('Tools: {TOOL_LIST}. JSON: {"a": 1} and {lower}.', options());
        const out = renderTemplate(parsed, new Map([["TOOL_LIST", "- bash"]]));
        assert.equal(out.system, 'Tools: - bash. JSON: {"a": 1} and {lower}.');
    });

    it("keeps unknown placeholders verbatim", () => {
        const parsed = parseTemplate("Hello {NOBODY_KNOWS}", options());
        assert.equal(renderTemplate(parsed, new Map()).system, "Hello {NOBODY_KNOWS}");
        assert.deepEqual(parsed.uses, [{ name: "NOBODY_KNOWS", isBeforeMarker: true }]);
    });

    it("splits at the first CACHE_MARKER", () => {
        const parsed = parseTemplate("static {A}\n\n{CACHE_MARKER}\n\ndynamic {B}", options());
        const out = renderTemplate(
            parsed,
            new Map([
                ["A", "a"],
                ["B", "b"],
            ]),
        );
        assert.equal(out.system, "static a");
        assert.equal(out.userHead, "dynamic b");
        assert.deepEqual(parsed.uses, [
            { name: "A", isBeforeMarker: true },
            { name: "B", isBeforeMarker: false },
        ]);
    });

    it("puts everything into the system prompt without a marker", () => {
        const out = renderTemplate(parseTemplate("only {A}", options()), new Map([["A", "x"]]));
        assert.equal(out.system, "only x");
        assert.equal(out.userHead, "");
    });

    it("warns about and drops a second marker", () => {
        const parsed = parseTemplate("a {CACHE_MARKER} b {CACHE_MARKER} c", options());
        const out = renderTemplate(parsed, new Map());
        assert.equal(out.system, "a");
        assert.equal(out.userHead, "b  c");
        assert.equal(parsed.warnings.length, 1);
    });

    it("expands includes recursively and redacts them on request", () => {
        const parsed = parseTemplate(
            "# Identity\n\n{SOUL.md}",
            options({ "SOUL.md": "I am {NAME}. {extra/more.md}", "extra/more.md": "More." }),
        );
        const values = new Map([["NAME", "Familiar"]]);
        assert.equal(renderTemplate(parsed, values).system, "# Identity\n\nI am Familiar. More.");
        assert.equal(
            renderTemplate(parsed, values, true).system,
            "# Identity\n\n<content of file SOUL.md>",
        );
        assert.deepEqual(parsed.includes, ["SOUL.md", "extra/more.md"]);
    });

    it("renders a missing include as empty with a warning", () => {
        const parsed = parseTemplate("a{MISSING.md}b", options());
        assert.equal(renderTemplate(parsed, new Map()).system, "ab");
        assert.match(parsed.warnings[0] ?? "", /MISSING\.md.*not found/);
    });

    it("rejects include paths leaving the workspace", () => {
        const parsed = parseTemplate("{../secret.md}", options({ "../secret.md": "nope" }));
        assert.equal(renderTemplate(parsed, new Map()).system, "{../secret.md}");
        assert.match(parsed.warnings[0] ?? "", /rejected/);
    });

    it("stops include cycles with a warning", () => {
        const parsed = parseTemplate("{a.md}", options({ "a.md": "A {b.md}", "b.md": "B {a.md}" }));
        assert.equal(renderTemplate(parsed, new Map()).system, "A B {a.md}");
        assert.match(parsed.warnings[0] ?? "", /recursive/);
    });

    it("expands template sources like HANDLER_CONTENT", () => {
        const parsed = parseTemplate(
            "# Handler\n\n{HANDLER_CONTENT}",
            options(
                { "rules.md": "Rule 1." },
                { HANDLER_CONTENT: "Do it. {rules.md} {TOOL_LIST}" },
            ),
        );
        const out = renderTemplate(parsed, new Map([["TOOL_LIST", "- x"]]), true);
        assert.equal(out.system, "# Handler\n\nDo it. <content of file rules.md> - x");
    });

    it("ignores a marker inside a template source", () => {
        const parsed = parseTemplate(
            "{HANDLER_CONTENT}",
            options({}, { HANDLER_CONTENT: "a {CACHE_MARKER} b" }),
        );
        const out = renderTemplate(parsed, new Map());
        assert.equal(out.system, "a  b");
        assert.equal(out.userHead, "");
        assert.equal(parsed.warnings.length, 1);
    });

    it("never expands tokens inside resolved values", () => {
        const parsed = parseTemplate("{STAGED_FILE_LIST}", options({ "SOUL.md": "secret soul" }));
        const out = renderTemplate(
            parsed,
            new Map([["STAGED_FILE_LIST", "{SOUL.md} {TOOL_LIST}"]]),
        );
        assert.equal(out.system, "{SOUL.md} {TOOL_LIST}");
    });
});

describe("isSafeIncludePath", () => {
    it("accepts workspace-relative paths", () => {
        assert.equal(isSafeIncludePath("SOUL.md"), true);
        assert.equal(isSafeIncludePath("prompts/minimal.md"), true);
    });

    it("rejects absolute, parent and empty segments", () => {
        assert.equal(isSafeIncludePath("/etc/x.md"), false);
        assert.equal(isSafeIncludePath("../x.md"), false);
        assert.equal(isSafeIncludePath("a//x.md"), false);
    });
});
