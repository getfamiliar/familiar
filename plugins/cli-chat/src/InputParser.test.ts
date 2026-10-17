import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInput } from "./InputParser.js";

test("plain text becomes a default handler call", () => {
    assert.deepEqual(parseInput("hello there"), {
        kind: "handler",
        prompt: "hello there",
        rawInput: "hello there",
    });
});

test("/exit and /clear are builtins", () => {
    assert.deepEqual(parseInput("/exit"), { kind: "builtin", command: "/exit" });
    assert.deepEqual(parseInput("/clear"), { kind: "builtin", command: "/clear" });
});

test("two-segment path becomes a handler call", () => {
    assert.deepEqual(parseInput("/calendar/today"), {
        kind: "handler",
        topic: "calendar:today",
        prompt: "",
        rawInput: "/calendar/today",
    });
});

test("three-segment path joins topic with colons", () => {
    assert.deepEqual(parseInput("/grocery/fruits/order Please order apples"), {
        kind: "handler",
        topic: "grocery:fruits:order",
        prompt: "Please order apples",
        rawInput: "/grocery/fruits/order Please order apples",
    });
});

test("single-segment path addresses a top-level topic", () => {
    assert.deepEqual(parseInput("/mail bar"), {
        kind: "handler",
        topic: "mail",
        prompt: "bar",
        rawInput: "/mail bar",
    });
});

test("a bare slash falls back to plain prompt", () => {
    assert.deepEqual(parseInput("/ bar"), {
        kind: "handler",
        prompt: "/ bar",
        rawInput: "/ bar",
    });
});

test("trailing slashes are ignored, not turned into empty segments", () => {
    assert.deepEqual(parseInput("/grocery/fruits/"), {
        kind: "handler",
        topic: "grocery:fruits",
        prompt: "",
        rawInput: "/grocery/fruits/",
    });
});

test("leading whitespace is trimmed", () => {
    assert.deepEqual(parseInput("   /exit"), { kind: "builtin", command: "/exit" });
});
