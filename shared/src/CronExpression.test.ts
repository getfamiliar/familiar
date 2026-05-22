import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeFriendly, parseCron } from "./CronExpression.js";

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

test("parseCron tolerates a missing `at` after `everyday`", () => {
    // Without normalization friendly-node-cron returns null for this
    // shape; verbatim is also not a raw cron expression.
    const r = parseCron("everyday 4:00am");
    assert.ok(r, "expected parseCron to recover `everyday 4:00am`");
    assert.equal(r.source, "friendly");
    // 04:00 daily — seconds field is provided by friendly-node-cron's
    // 6-field output.
    assert.equal(r.expression, "0 0 4 * * *");
    // Verbatim is the original input the operator wrote.
    assert.equal(r.verbatim, "everyday 4:00am");
});

test("parseCron tolerates a missing `at` after `every <day-name>`", () => {
    // Without normalization friendly accepts the day token but drops
    // the hour entirely — yielding a silent midnight schedule. With
    // normalization the hour survives.
    const r = parseCron("every monday 4:00am");
    assert.ok(r);
    assert.equal(r.source, "friendly");
    assert.equal(r.expression, "0 0 4 * * 1");
});

test("normalizeFriendly does not break inputs that already have `at`", () => {
    assert.equal(normalizeFriendly("every day at 4:00am"), "every day at 4:00am");
    assert.equal(normalizeFriendly("every monday at 8 am"), "every monday at 8 am");
});

test("normalizeFriendly does not interfere with `every N <unit>` shapes", () => {
    assert.equal(normalizeFriendly("every 5 minutes"), "every 5 minutes");
    assert.equal(normalizeFriendly("every 2 hours"), "every 2 hours");
});
