import assert from "node:assert/strict";
import { test } from "node:test";
import { unwrapToolCall } from "./ToolCallProxy.js";

test("unwrapToolCall returns the proxied tool's name and arguments", () => {
    const call = unwrapToolCall({
        toolCallId: "c1",
        toolName: "tool_call",
        input: { name: "calendar_list_events", arguments: { from_day: "2026-11-12" } },
    });
    assert.deepEqual(call, {
        id: "c1",
        name: "calendar_list_events",
        input: { from_day: "2026-11-12" },
    });
});

test("unwrapToolCall defaults missing proxy arguments to an empty object", () => {
    const call = unwrapToolCall({ toolName: "tool_call", input: { name: "banner_list" } });
    assert.deepEqual(call, { id: null, name: "banner_list", input: {} });
});

test("unwrapToolCall keeps a proxy call without a usable name", () => {
    assert.equal(unwrapToolCall({ toolName: "tool_call", input: {} }).name, "tool_call");
    assert.equal(unwrapToolCall({ toolName: "tool_call", input: "oops" }).name, "tool_call");
    assert.equal(unwrapToolCall({ toolName: "tool_call", input: null }).name, "tool_call");
});

test("unwrapToolCall leaves direct calls unchanged", () => {
    const call = unwrapToolCall({ toolCallId: "c2", toolName: "fs_read", input: { path: "a.md" } });
    assert.deepEqual(call, { id: "c2", name: "fs_read", input: { path: "a.md" } });
});

test("unwrapToolCall names a call without toolName 'tool'", () => {
    assert.equal(unwrapToolCall({}).name, "tool");
});
