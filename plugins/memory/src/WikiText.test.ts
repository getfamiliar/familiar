import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { findNonIsoDates } from "./WikiText.js";

/** The `text → iso` pairs found in a line, for compact assertions. */
function found(line: string): string[] {
    return findNonIsoDates(line).map((date) => `${date.text} → ${date.iso ?? "?"}`);
}

describe("findNonIsoDates", () => {
    it("finds German dotted dates, with two- or four-digit years", () => {
        assert.deepEqual(found("- 12.07.2026: Notartermin"), ["12.07.2026 → 2026-07-12"]);
        assert.deepEqual(found("am 1.3.26 unterschrieben"), ["1.3.26 → 2026-03-01"]);
    });

    it("finds dates with German and English month names", () => {
        assert.deepEqual(found("Hochzeit am 12. Juli 2026 in Ulm"), ["12. Juli 2026 → 2026-07-12"]);
        assert.deepEqual(found("since 3 März 2025"), ["3 März 2025 → 2025-03-03"]);
        assert.deepEqual(found("signed on July 12, 2026"), ["July 12, 2026 → 2026-07-12"]);
        assert.deepEqual(found("the 2nd of Dec. 2025"), ["2nd of Dec. 2025 → 2025-12-02"]);
        assert.deepEqual(found("Sep 3rd 2024 kickoff"), ["Sep 3rd 2024 → 2024-09-03"]);
    });

    it("finds a month with a year, once, and not inside a full date", () => {
        assert.deepEqual(found("Umzug im Juli 2026"), ["Juli 2026 → 2026-07"]);
        assert.deepEqual(found("12. Mai 2026 und Mai 2027"), [
            "12. Mai 2026 → 2026-05-12",
            "Mai 2027 → 2027-05",
        ]);
    });

    it("converts slashed dates only when the order is clear", () => {
        assert.deepEqual(found("due 07/25/2026"), ["07/25/2026 → 2026-07-25"]);
        assert.deepEqual(found("fällig 25/07/2026"), ["25/07/2026 → 2026-07-25"]);
        assert.deepEqual(found("call on 03/04/2026"), ["03/04/2026 → ?"]);
        assert.deepEqual(found("call on 05/05/2026"), ["05/05/2026 → 2026-05-05"]);
    });

    it("ignores ISO dates, version numbers, impossible dates and dates without a year", () => {
        assert.deepEqual(found("- 2026-07-12: signed; 2026-07 trip"), []);
        assert.deepEqual(found("upgraded to 1.2.3 and 10.4.1.2"), []);
        assert.deepEqual(found("ab Basel SBB Tram 8/10/11 bis Aeschenplatz"), []);
        assert.deepEqual(found("31.02.2026 is no day, 13/13/2026 neither"), []);
        assert.deepEqual(found("Geburtstag am 12. Mai"), []);
        assert.deepEqual(found("Mai ist schön, 2026 auch"), []);
    });

    it("ignores inline code, URLs and wikilinks", () => {
        assert.deepEqual(found("format `12.07.2026` like this"), []);
        assert.deepEqual(found("see https://example.com/news/12/07/2026/story"), []);
        assert.deepEqual(found("[[journal/Juli 2026]]"), []);
    });

    it("reports the column of each finding", () => {
        assert.deepEqual(
            findNonIsoDates("ab 01.02.2026").map((date) => date.column),
            [3],
        );
    });
});
