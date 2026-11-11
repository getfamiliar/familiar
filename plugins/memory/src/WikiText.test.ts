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

    it("takes a range with a shortened start as one finding", () => {
        assert.deepEqual(found("Reha 22.09.–20.10.2026"), [
            "22.09.–20.10.2026 → 2026-09-22 – 2026-10-20",
        ]);
        assert.deepEqual(found("(10.–12.07.2026)"), ["10.–12.07.2026 → 2026-07-10 – 2026-07-12"]);
        assert.deepEqual(found("seit 03./04.08.2026"), [
            "03./04.08.2026 → 2026-08-03 / 2026-08-04",
        ]);
        assert.deepEqual(found("22.09. - 20.10.2026"), [
            "22.09. - 20.10.2026 → 2026-09-22 – 2026-10-20",
        ]);
        assert.deepEqual(found("12., 13. und 14. Juli 2026"), [
            "12., 13. und 14. Juli 2026 → 2026-07-12, 2026-07-13 und 2026-07-14",
        ]);
    });

    it("repairs a range whose end is ISO already", () => {
        assert.deepEqual(found("22.09.–2026-10-20"), [
            "22.09.–2026-10-20 → 2026-09-22 – 2026-10-20",
        ]);
        assert.deepEqual(found("09.–2026-10-21"), ["09.–2026-10-21 → 2026-10-09 – 2026-10-21"]);
        assert.deepEqual(found("03./2026-08-04"), ["03./2026-08-04 → 2026-08-03 / 2026-08-04"]);
    });

    it("steps back a month or a year for a start after the end", () => {
        assert.deepEqual(found("28.12.–03.01.2027"), [
            "28.12.–03.01.2027 → 2026-12-28 – 2027-01-03",
        ]);
        assert.deepEqual(found("28.–03.01.2027"), ["28.–03.01.2027 → 2026-12-28 – 2027-01-03"]);
        assert.deepEqual(found("30.–02.10.2026"), ["30.–02.10.2026 → 2026-09-30 – 2026-10-02"]);
    });

    it("keeps an enumeration in its month and year, even when it runs backwards", () => {
        assert.deepEqual(found("27.10., 06.10. und 05.10.2026"), [
            "27.10., 06.10. und 05.10.2026 → 2026-10-27, 2026-10-06 und 2026-10-05",
        ]);
        assert.deepEqual(found("29. und 27.10.2026"), [
            "29. und 27.10.2026 → 2026-10-29 und 2026-10-27",
        ]);
    });

    it("leaves ordinals and impossible starts out of the span", () => {
        assert.deepEqual(found("2027-11-04 der 41., 2027-11-18 der 42."), []);
        assert.deepEqual(found("2027-11-04 der 5., 2027-11-18 der 6."), []);
        assert.deepEqual(found("Kapitel 41.–12.07.2026"), ["12.07.2026 → 2026-07-12"]);
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
