import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseWikiFile } from "./WikiParser.js";
import { extractIsoDates, normalizeText } from "./WikiText.js";

describe("parseWikiFile", () => {
    it("takes title and description from the h1 and the paragraph under it", () => {
        const parsed = parseWikiFile(
            "wiki/people/alice-smith.md",
            "---\ncategories: [Kunden, arbeit]\nreview_at: 2026-11-20\n---\n# Alice Smith\n\nSenior PM at Acme;\nbased in Atlanta.\n\n## Meetings\n- 2026-05-12: kickoff\n",
        );
        assert.equal(parsed.title, "Alice Smith");
        assert.equal(parsed.description, "Senior PM at Acme; based in Atlanta.");
        assert.deepEqual(parsed.categories, ["kunden", "arbeit"]);
        assert.equal(parsed.reviewAt, "2026-11-20");
        assert.deepEqual(parsed.warnings, []);
        const kickoff = parsed.lines.find((line) => line.text.includes("kickoff"));
        assert.equal(kickoff?.headingTrail, "Alice Smith > Meetings");
        assert.equal(kickoff?.lineNo, 11);
        assert.deepEqual(parsed.dates, [
            { lineNo: 11, from: "2026-05-12", to: "2026-05-12", snippet: "- 2026-05-12: kickoff" },
        ]);
    });

    it("leaves the description empty when a list follows the h1", () => {
        const parsed = parseWikiFile("wiki/x.md", "# X\n\n- just a list\n");
        assert.equal(parsed.description, "");
    });

    it("falls back to the file name without an h1", () => {
        assert.equal(
            parseWikiFile("wiki/threads/acme-rollout.md", "notes only\n").title,
            "acme-rollout",
        );
    });

    it("ignores headings inside code fences", () => {
        const parsed = parseWikiFile("wiki/x.md", "# X\n\nAbout x.\n\n```\n# not a heading\n```\n");
        const fenced = parsed.lines.find((line) => line.text === "# not a heading");
        assert.equal(fenced?.isHeading, false);
    });

    it("reports invalid frontmatter values and keeps going", () => {
        const parsed = parseWikiFile(
            "wiki/x.md",
            "---\nreview_at: 20.11.2026\ncategories: [1]\n---\n# X\n",
        );
        assert.equal(parsed.reviewAt, undefined);
        assert.deepEqual(parsed.categories, []);
        assert.equal(parsed.warnings.length, 2);
        assert.equal(parsed.title, "X");
    });
});

describe("extractIsoDates", () => {
    it("expands a month to its first and last day", () => {
        assert.deepEqual(extractIsoDates("Urlaub 2026-02 und 2024-02"), [
            { from: "2026-02-01", to: "2026-02-28" },
            { from: "2024-02-01", to: "2024-02-29" },
        ]);
    });

    it("skips invalid dates, bare years and paths", () => {
        assert.deepEqual(extractIsoDates("2026-02-30, 2026-13, 2026, journal/2026-07"), []);
    });

    it("finds a date followed by a time", () => {
        assert.deepEqual(extractIsoDates("- 2026-07-12 14:30: call"), [
            { from: "2026-07-12", to: "2026-07-12" },
        ]);
    });
});

describe("normalizeText", () => {
    it("folds case, diacritics and ß", () => {
        assert.equal(normalizeText("  Björn   GRÖẞLER "), "bjorn grossler");
        assert.equal(normalizeText("Größler"), "grossler");
    });
});
