import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesAnyGlob, matchesGlob } from "./PathGlob.js";

test("wiki/** matches paths under wiki", () => {
    assert.equal(matchesGlob("wiki/**", "wiki/index.md"), true);
    assert.equal(matchesGlob("wiki/**", "wiki/notes/deep/recipe.md"), true);
});

test("wiki/** is rooted at the workspace root — no floating substring match", () => {
    // The whole point of anchoring: a sibling topic that merely *ends*
    // with `wiki/...` must not be treated as writable.
    assert.equal(matchesGlob("wiki/**", "notwiki/secret.md"), false);
    assert.equal(matchesGlob("wiki/**", "mail/wiki/leak.md"), false);
});

test("literal characters are matched literally, dots are not wildcards", () => {
    assert.equal(matchesGlob("people/*", "people/anna.md"), true);
    assert.equal(matchesGlob("people/*", "peopleX/anna.md"), false);
    assert.equal(matchesGlob("a.md", "axmd"), false);
});

test("bare * and ** match everything", () => {
    assert.equal(matchesGlob("*", "anything/at/all.md"), true);
    assert.equal(matchesGlob("**", ""), true);
});

test("matchesAnyGlob is true iff at least one pattern matches", () => {
    assert.equal(matchesAnyGlob(["wiki/**", "drafts/**"], "drafts/x.md"), true);
    assert.equal(matchesAnyGlob(["wiki/**", "drafts/**"], "mail/x.md"), false);
    assert.equal(matchesAnyGlob([], "wiki/x.md"), false);
});
