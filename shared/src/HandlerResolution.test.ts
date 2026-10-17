import assert from "node:assert/strict";
import { test } from "node:test";
import {
    handlerCandidateLevels,
    resolveHandlerPath,
    topicFromHandlerPath,
    twinHandlerPath,
} from "./HandlerResolution.js";

test("candidate levels walk up the topic chain, file form first", () => {
    assert.deepEqual(handlerCandidateLevels("mail:new:ms365", { isExactTopic: false }), [
        ["mail/new/ms365.md", "mail/new/ms365/index.md"],
        ["mail/new.md", "mail/new/index.md"],
        ["mail/index.md"],
    ]);
});

test("exact topics only try their own level", () => {
    assert.deepEqual(handlerCandidateLevels("skills:memory:save", { isExactTopic: true }), [
        ["skills/memory/save.md", "skills/memory/save/index.md"],
    ]);
});

test("a single-segment topic never resolves to a workspace-root file", () => {
    assert.deepEqual(handlerCandidateLevels("mail", { isExactTopic: false }), [["mail/index.md"]]);
});

test("resolve picks the most specific existing file and only that file", () => {
    const files = new Set(["mail/index.md", "mail/new.md"]);
    const hit = resolveHandlerPath("mail:new:ms365", { isExactTopic: false }, (p) => files.has(p));
    assert.deepEqual(hit, { relativePath: "mail/new.md", shadowedPath: null });
});

test("resolve prefers x.md over x/index.md and reports the shadowed twin", () => {
    const files = new Set(["mail/new/ms365.md", "mail/new/ms365/index.md"]);
    const hit = resolveHandlerPath("mail:new:ms365", { isExactTopic: true }, (p) => files.has(p));
    assert.deepEqual(hit, {
        relativePath: "mail/new/ms365.md",
        shadowedPath: "mail/new/ms365/index.md",
    });
});

test("resolve returns null for an exact topic whose own file is missing", () => {
    const files = new Set(["mail/index.md"]);
    assert.equal(
        resolveHandlerPath("mail:analyze", { isExactTopic: true }, (p) => files.has(p)),
        null,
    );
});

test("topicFromHandlerPath maps both handler forms", () => {
    assert.equal(topicFromHandlerPath("mail/important/digest.md"), "mail:important:digest");
    assert.equal(topicFromHandlerPath("mail/new/index.md"), "mail:new");
    assert.equal(topicFromHandlerPath("mail/index.md"), "mail");
    assert.equal(topicFromHandlerPath("mail/extract-style.md"), "mail:extract-style");
});

test("topicFromHandlerPath rejects root files and invalid segments", () => {
    assert.equal(topicFromHandlerPath("PROMPT.md"), null);
    assert.equal(topicFromHandlerPath("mail/notes.txt"), null);
    assert.equal(topicFromHandlerPath("mail/v1.2.md"), null);
    assert.equal(topicFromHandlerPath("mail/my notes.md"), null);
});

test("twinHandlerPath maps x.md and x/index.md onto each other", () => {
    assert.equal(twinHandlerPath("chat/cli.md"), "chat/cli/index.md");
    assert.equal(twinHandlerPath("chat/cli/index.md"), "chat/cli.md");
    assert.equal(twinHandlerPath("chat/index.md"), null);
    assert.equal(twinHandlerPath("PROMPT.md"), null);
});
