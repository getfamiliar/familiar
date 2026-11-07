import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatRuntimeTime } from "./RuntimeTime.js";

describe("formatRuntimeTime", () => {
    // 2026-05-19T16:43:12 UTC is Tuesday at 18:43:12 in Europe/Berlin
    // (DST in effect — UTC+2). Pinned UTC instant + explicit tz keeps
    // the test deterministic regardless of the container's system tz.
    const fixed = new Date("2026-05-19T16:43:12Z");

    it("renders weekday + ISO-shaped local time + IANA tz label", () => {
        assert.equal(
            formatRuntimeTime(fixed, "Europe/Berlin"),
            "Tuesday, 2026-05-19T18:43:12 in timezone Europe/Berlin",
        );
    });

    it("respects a different timezone", () => {
        assert.equal(
            formatRuntimeTime(fixed, "America/Los_Angeles"),
            "Tuesday, 2026-05-19T09:43:12 in timezone America/Los_Angeles",
        );
    });
});
