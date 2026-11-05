import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChatInput } from "./ChatInput.js";

const BUILTINS = ["/clear"] as const;

test("plain text becomes a plain message", () => {
    assert.deepEqual(parseChatInput("  hello there ", BUILTINS), {
        kind: "handler",
        prompt: "hello there",
        rawInput: "hello there",
    });
});

test("only the given builtins are builtins", () => {
    assert.deepEqual(parseChatInput("/clear", BUILTINS), { kind: "builtin", command: "/clear" });
    assert.deepEqual(parseChatInput("/exit", BUILTINS), {
        kind: "handler",
        topic: "exit",
        prompt: "",
        rawInput: "/exit",
    });
});

test("a slash path becomes a direct handler call with the rest as prompt", () => {
    assert.deepEqual(parseChatInput("/grocery/fruits/order Please order apples", BUILTINS), {
        kind: "handler",
        topic: "grocery:fruits:order",
        prompt: "Please order apples",
        rawInput: "/grocery/fruits/order Please order apples",
    });
    assert.equal(parseChatInput("/grocery/fruits/", BUILTINS).kind, "handler");
});

test("a bare slash is a plain message", () => {
    assert.deepEqual(parseChatInput("/ bar", BUILTINS), {
        kind: "handler",
        prompt: "/ bar",
        rawInput: "/ bar",
    });
});
