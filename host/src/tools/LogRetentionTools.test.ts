import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatMcpLine } from "./LogRetentionTools.js";

const FIXED = new Date(Date.UTC(2026, 4, 8, 9, 14, 32, 7));

describe("formatMcpLine", () => {
    it("emits a 19-char fixed prefix for stdout", () => {
        const out = formatMcpLine("out", "hello", FIXED);
        assert.equal(out, "09:14:32.007  out  hello");
        assert.equal(out.indexOf("hello"), 19);
    });

    it("emits a 19-char fixed prefix for stderr", () => {
        const out = formatMcpLine("err", "boom", FIXED);
        assert.equal(out, "09:14:32.007  err  boom");
        assert.equal(out.indexOf("boom"), 19);
    });

    it("collapses embedded newlines to spaces", () => {
        const out = formatMcpLine("out", "first\nsecond\rthird", FIXED);
        assert.equal(out, "09:14:32.007  out  first second third");
    });

    it("collapses runs of CR/LF to a single space", () => {
        const out = formatMcpLine("err", "a\r\n\r\nb", FIXED);
        assert.equal(out, "09:14:32.007  err  a b");
    });

    it("passes long lines through verbatim (no truncation)", () => {
        const long = "x".repeat(5000);
        const out = formatMcpLine("out", long, FIXED);
        assert.equal(out.length, 19 + 5000);
        assert.ok(out.endsWith(long));
    });

    it("zero-pads timestamps", () => {
        const earlyMorning = new Date(Date.UTC(2026, 0, 1, 0, 0, 5, 9));
        const out = formatMcpLine("out", "x", earlyMorning);
        assert.equal(out, "00:00:05.009  out  x");
    });
});
