import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    buildStepBudgetNotice,
    LAST_TURN_NOTICE,
    STEP_BUDGET_WARNING_THRESHOLD,
} from "./stepBudgetNotice.js";

describe("buildStepBudgetNotice — 15-step cap", () => {
    const MAX = 15;

    it("returns null while the agent has comfortable runway (stepNumber 0..11)", () => {
        for (let stepNumber = 0; stepNumber <= 11; stepNumber++) {
            assert.equal(
                buildStepBudgetNotice(stepNumber, MAX),
                null,
                `expected no notice at stepNumber=${stepNumber} (remaining=${MAX - stepNumber})`,
            );
        }
    });

    it("injects a live-count countdown when 3 or 2 steps remain", () => {
        const at3 = buildStepBudgetNotice(12, MAX); // remaining = 3
        assert.ok(at3?.includes("only 3 steps"), at3 ?? "(null)");

        const at2 = buildStepBudgetNotice(13, MAX); // remaining = 2
        assert.ok(at2?.includes("only 2 steps"), at2 ?? "(null)");
    });

    it("switches to the last-turn notice on the final step", () => {
        assert.equal(buildStepBudgetNotice(14, MAX), LAST_TURN_NOTICE); // remaining = 1
    });
});

describe("buildStepBudgetNotice — threshold arithmetic (small cap)", () => {
    // maxSteps = 4 pins the boundaries independently of the 15 default.
    const MAX = 4;

    it("null above the threshold, countdown at 3/2, last-turn at 1", () => {
        assert.equal(buildStepBudgetNotice(0, MAX), null); // remaining = 4
        assert.ok(buildStepBudgetNotice(1, MAX)?.includes("only 3 steps")); // remaining = 3
        assert.ok(buildStepBudgetNotice(2, MAX)?.includes("only 2 steps")); // remaining = 2
        assert.equal(buildStepBudgetNotice(3, MAX), LAST_TURN_NOTICE); // remaining = 1
    });

    it("countdown begins exactly at STEP_BUDGET_WARNING_THRESHOLD", () => {
        // One step before the threshold is reached → still null.
        const beforeThreshold = MAX - STEP_BUDGET_WARNING_THRESHOLD - 1;
        assert.equal(buildStepBudgetNotice(beforeThreshold, MAX), null);
        // At the threshold → countdown appears.
        assert.ok(buildStepBudgetNotice(beforeThreshold + 1, MAX) !== null);
    });

    it("defensively returns the last-turn notice if called past the cap", () => {
        assert.equal(buildStepBudgetNotice(MAX, MAX), LAST_TURN_NOTICE); // remaining = 0
        assert.equal(buildStepBudgetNotice(MAX + 1, MAX), LAST_TURN_NOTICE); // remaining = -1
    });
});
