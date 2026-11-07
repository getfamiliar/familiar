import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { type BannerRow, formatBannerList, formatBannerTime } from "./BannerBus.js";

/** A banner with defaults; tests override what they check. */
function banner(partial: Partial<BannerRow>): BannerRow {
    return {
        id: "1",
        text: "note",
        createdAt: "2026-11-06T11:30:00.000Z",
        expiresAt: "2026-11-06T22:59:00.000Z",
        createdByAgentrunId: null,
        createdByTopic: null,
        ...partial,
    };
}

describe("formatBannerTime", () => {
    it("renders local wall-clock minutes", () => {
        assert.equal(
            formatBannerTime("2026-11-06T11:30:00.000Z", "Europe/Berlin"),
            "2026-11-06 12:30",
        );
    });

    it("falls back to the input for an unknown zone", () => {
        assert.equal(
            formatBannerTime("2026-11-06T11:30:00.000Z", "Nowhere/Land"),
            "2026-11-06T11:30:00.000Z",
        );
    });
});

describe("formatBannerList", () => {
    it("renders (none) for no banners", () => {
        assert.equal(formatBannerList([], "UTC"), "(none)");
    });

    it("renders one bullet per banner with id, creation and expiry", () => {
        const out = formatBannerList(
            [
                banner({ id: "123", text: "User is ill and stays in bed." }),
                banner({ id: "124", text: "line one\n\n  line two" }),
            ],
            "Europe/Berlin",
        );
        assert.equal(
            out,
            [
                "* [ID:123] 2026-11-06 12:30 (until 2026-11-06 23:59): User is ill and stays in bed.",
                "* [ID:124] 2026-11-06 12:30 (until 2026-11-06 23:59): line one line two",
            ].join("\n"),
        );
    });
});
