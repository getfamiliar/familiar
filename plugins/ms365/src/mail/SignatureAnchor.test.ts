import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAnchor, MIN_ANCHOR_LENGTH } from "./SignatureAnchor.js";

test("extractAnchor returns the longest non-whitespace run", () => {
    const sig = `<div>Steffen Müller<br>Cottleston Engineering</div>`;
    // After plain-text + split: ["Steffen", "Müller", "Cottleston", "Engineering"]
    // Longest run is "Engineering" (11 chars).
    assert.equal(extractAnchor(sig), "Engineering");
});

test("extractAnchor enforces the minimum length", () => {
    // Every run is shorter than the 8-char minimum.
    const sig = `<p>Best,<br>Bob</p>`;
    assert.equal(extractAnchor(sig), null);
});

test("extractAnchor accepts a single run of exactly the minimum length", () => {
    const sig = `<p>${"a".repeat(MIN_ANCHOR_LENGTH)}</p>`;
    assert.equal(extractAnchor(sig), "a".repeat(MIN_ANCHOR_LENGTH));
});

test("extractAnchor returns null on an empty signature", () => {
    assert.equal(extractAnchor(""), null);
});

test("extractAnchor returns null on a tags-only signature", () => {
    assert.equal(extractAnchor("<div></div><span></span>"), null);
});

test("extractAnchor decodes entities before measuring", () => {
    const sig = `<p>R&amp;D Department</p>`;
    // Plain text → "R&D Department" → runs "R&D" (3) and "Department" (10).
    assert.equal(extractAnchor(sig), "Department");
});

test("extractAnchor handles a phone-number-style run", () => {
    const sig = `<p>Call: +49-30-12345678</p>`;
    // Longest run is "+49-30-12345678" (15 chars; non-whitespace).
    assert.equal(extractAnchor(sig), "+49-30-12345678");
});
