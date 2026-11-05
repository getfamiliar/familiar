import assert from "node:assert/strict";
import { test } from "node:test";
import { isHiddenScratchFile, scratchSpillFileName } from "./Scratch.js";

test("spill names are hidden, keep the extension and get a random token", () => {
    assert.match(scratchSpillFileName("result.json"), /^\.result-[0-9a-f]{8}\.json$/);
    assert.match(scratchSpillFileName("payload"), /^\.payload-[0-9a-f]{8}$/);
    assert.match(scratchSpillFileName(".env"), /^\.env-[0-9a-f]{8}$/);
    assert.notEqual(scratchSpillFileName("a.txt"), scratchSpillFileName("a.txt"));
    assert.equal(isHiddenScratchFile(scratchSpillFileName("a.txt")), true);
    assert.equal(isHiddenScratchFile("report.pdf"), false);
});
