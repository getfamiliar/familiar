import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToHandlerTarget } from "./CronjobScheduler.js";

test("pathToHandlerTarget maps nested folders to colon-joined topics", () => {
    assert.deepEqual(pathToHandlerTarget("mail/important/digest.md"), {
        topic: "mail:important",
        startHandler: "digest",
    });
});

test("pathToHandlerTarget handles a single-folder file", () => {
    assert.deepEqual(pathToHandlerTarget("workflows/monday-digest.md"), {
        topic: "workflows",
        startHandler: "monday-digest",
    });
});

test("pathToHandlerTarget rejects workspace-root files", () => {
    assert.equal(pathToHandlerTarget("SOUL.md"), null);
    assert.equal(pathToHandlerTarget("loose.md"), null);
});

test("pathToHandlerTarget strips the .md suffix only", () => {
    const t = pathToHandlerTarget("workflows/has.dot.in.name.md");
    assert.deepEqual(t, { topic: "workflows", startHandler: "has.dot.in.name" });
});
