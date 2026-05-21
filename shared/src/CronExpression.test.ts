import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCron } from "./CronExpression.js";

test("parseCron accepts a friendly grammar", () => {
    const r = parseCron("every monday at 8");
    assert.ok(r);
    assert.equal(r.source, "friendly");
    // Croner has to be able to run whatever friendly produced.
    assert.ok(r.expression.length > 0);
});

test("parseCron falls back to raw cron for 5-field expressions", () => {
    const r = parseCron("0 8 * * 1");
    assert.ok(r);
    assert.equal(r.source, "raw");
    assert.equal(r.expression, "0 8 * * 1");
});

test("parseCron falls back to raw cron for 6-field expressions", () => {
    const r = parseCron("*/30 * * * * *");
    assert.ok(r);
    assert.equal(r.source, "raw");
    assert.equal(r.expression, "*/30 * * * * *");
});

test("parseCron returns null for nonsense", () => {
    const r = parseCron("not a cron expression at all");
    assert.equal(r, null);
});

test("parseCron returns null for empty input", () => {
    assert.equal(parseCron(""), null);
});

test("parseCron preserves the verbatim string on success", () => {
    const r = parseCron("0 0 1 1 *");
    assert.ok(r);
    assert.equal(r.verbatim, "0 0 1 1 *");
});
