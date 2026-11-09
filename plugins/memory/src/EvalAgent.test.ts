import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseAnswer } from "./EvalAgent.js";

describe("parseAnswer", () => {
    it("reads the paths of the last FILES line", () => {
        assert.deepEqual(parseAnswer("Found it.\nFILES: wiki/people/a.md, `threads/b.md`\n"), [
            "wiki/people/a.md",
            "wiki/threads/b.md",
        ]);
    });

    it("returns nothing for none or a missing line", () => {
        assert.deepEqual(parseAnswer("**FILES:** none"), []);
        assert.deepEqual(parseAnswer("I could not find anything."), []);
    });
});
