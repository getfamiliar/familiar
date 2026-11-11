import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { fixUnambiguousDates, type LintRule, lintWikiFile } from "./WikiLint.js";

/** `line:rule` pairs of the problems in `content`. */
function rules(content: string): string[] {
    return lintWikiFile(content).map((problem) => `${problem.lineNo}:${problem.rule}`);
}

/** The rule of the only problem in `content`. */
function onlyRule(content: string): LintRule {
    const problems = lintWikiFile(content);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    return problems[0].rule;
}

describe("lintWikiFile", () => {
    it("accepts a file that follows the conventions", () => {
        assert.deepEqual(
            rules(
                "---\ncategories: [property, inheritance]\nreview_at: 2026-11-20\n---\n# Alte Mühle\n\nSale of the house.\n\n- 2026-07-12: notary\n",
            ),
            [],
        );
        assert.deepEqual(rules("# No frontmatter\n\nJust text.\n"), []);
        assert.deepEqual(rules("---\ncategories: family\n---\n# Smith family\n"), []);
        assert.deepEqual(rules("---\ncategories: []\n---\n# Empty list\n"), []);
    });

    it("reports broken frontmatter", () => {
        assert.equal(onlyRule("---\ncategories: [a\n---\n# X\n"), "frontmatter");
        assert.equal(onlyRule("---\ncategories: [a]\n# never closed\n"), "frontmatter");
        assert.equal(onlyRule("---\n- just\n- a list\n---\n# X\n"), "frontmatter");
    });

    it("reports unknown frontmatter keys on their line", () => {
        assert.deepEqual(rules("---\ncategories: [work]\ntags: [x]\n---\n# X\n"), [
            "3:frontmatter-key",
        ]);
    });

    it("reports block lists, too many, non-word and duplicate categories", () => {
        assert.deepEqual(rules("---\ncategories:\n  - work\n---\n# X\n"), ["2:categories"]);
        assert.equal(onlyRule("---\ncategories: [a, b, c, d]\n---\n# X\n"), "categories");
        assert.equal(onlyRule("---\ncategories: [Work]\n---\n# X\n"), "categories");
        assert.equal(onlyRule("---\ncategories: [real estate]\n---\n# X\n"), "categories");
        assert.equal(onlyRule("---\ncategories: [property, property]\n---\n# X\n"), "categories");
        assert.deepEqual(rules("---\ncategories: [real-estate, ü-bahn, b2b]\n---\n# X\n"), []);
    });

    it("reports a review_at that is not an ISO date", () => {
        assert.deepEqual(rules("---\nreview_at: 20.11.2026\n---\n# X\n"), ["2:review-at"]);
        assert.deepEqual(rules('---\nreview_at: "2026-11-20"\n---\n# X\n'), []);
    });

    it("reports non-ISO dates in the body, but not inside code fences", () => {
        const problems = lintWikiFile(
            "# X\n\n- 12.07.2026: signed\n```\n12.07.2026\n```\n- July 2026: trip\n",
        );
        assert.deepEqual(
            problems.map((problem) => [problem.lineNo, problem.rule, problem.message]),
            [
                [3, "non-iso-date", '"12.07.2026" is not an ISO date — write 2026-07-12'],
                [7, "non-iso-date", '"July 2026" is not an ISO date — write 2026-07'],
            ],
        );
    });
});

describe("fixUnambiguousDates", () => {
    it("rewrites only unambiguous body dates, in place", () => {
        const { content, replacements } = fixUnambiguousDates(
            "---\nreview_at: 20.11.2026\n---\n# X\n\n- 12.07.2026 und 3. Mai 2026: a\n- 03/04/2026: b\n```\n12.07.2026\n```\n",
        );
        assert.equal(
            content,
            "---\nreview_at: 20.11.2026\n---\n# X\n\n- 2026-07-12 und 2026-05-03: a\n- 03/04/2026: b\n```\n12.07.2026\n```\n",
        );
        assert.deepEqual(replacements, [
            { lineNo: 6, from: "12.07.2026", to: "2026-07-12" },
            { lineNo: 6, from: "3. Mai 2026", to: "2026-05-03" },
        ]);
    });

    it("rewrites a whole range, and repairs a start left behind by an earlier pass", () => {
        const { content } = fixUnambiguousDates(
            "# X\n\n- Reha 22.09.–20.10.2026\n- Urlaub 03.–2026-10-19\n- 2026-07-12: ok\n",
        );
        assert.equal(
            content,
            "# X\n\n- Reha 2026-09-22 – 2026-10-20\n- Urlaub 2026-10-03 – 2026-10-19\n- 2026-07-12: ok\n",
        );
    });

    it("keeps CRLF line endings and returns unchanged content as is", () => {
        assert.equal(
            fixUnambiguousDates("# X\r\n\r\n- 1.2.2026\r\n").content,
            "# X\r\n\r\n- 2026-02-01\r\n",
        );
        const clean = "# X\n\n- 2026-02-01\n";
        assert.deepEqual(fixUnambiguousDates(clean), { content: clean, replacements: [] });
    });
});
