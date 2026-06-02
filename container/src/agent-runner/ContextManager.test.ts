import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@getfamiliar/shared";
import type { ModelMessage } from "ai";
import { ContextManager } from "./ContextManager.js";

/** Minimal logger stub recording whether `warn` was called. */
function makeLog(): { log: Logger; warned: () => boolean } {
    let warnCount = 0;
    const noop = () => {};
    const stub = {
        debug: noop,
        info: noop,
        warn: () => {
            warnCount++;
        },
        error: noop,
        child: () => stub,
    };
    return { log: stub as unknown as Logger, warned: () => warnCount > 0 };
}

/** A plain user message with `len` characters of content. */
function userText(len: number): ModelMessage {
    return { role: "user", content: "x".repeat(len) };
}

/** An assistant message issuing one tool call. */
function assistantCall(toolCallId: string, toolName: string, inputLen: number): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId, toolName, input: { q: "x".repeat(inputLen) } }],
    } as ModelMessage;
}

/** A tool message returning one (or more) text results. */
function toolResult(
    parts: ReadonlyArray<{ toolCallId: string; toolName: string; value: string }>,
): ModelMessage {
    return {
        role: "tool",
        content: parts.map((p) => ({
            type: "tool-result",
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            output: { type: "text", value: p.value },
        })),
    } as ModelMessage;
}

/** Extract the `value` of the first tool-result part of a tool message. */
function firstResultValue(message: ModelMessage): string {
    const content = message.content as Array<{ output?: { value?: unknown } }>;
    return String(content[0].output?.value ?? "");
}

test("eviction leaves the array unchanged when at most N tool messages", () => {
    const { log } = makeLog();
    const cm = new ContextManager({
        contextLimit: undefined,
        keptToolResultCount: 3,
        slidingWindowPercentage: 0.7,
        systemPromptTokens: 0,
        log,
    });
    const messages: ModelMessage[] = [
        userText(4),
        assistantCall("c1", "search", 4),
        toolResult([{ toolCallId: "c1", toolName: "search", value: "result-one" }]),
    ];
    const out = cm.prepare(messages);
    assert.deepEqual(out, messages);
});

test("eviction elides tool results older than the last N, preserving ids", () => {
    const { log } = makeLog();
    const cm = new ContextManager({
        contextLimit: undefined, // sliding window is a no-op
        keptToolResultCount: 1,
        slidingWindowPercentage: 0.7,
        systemPromptTokens: 0,
        log,
    });
    const messages: ModelMessage[] = [
        userText(4),
        assistantCall("c1", "alpha", 4),
        toolResult([{ toolCallId: "c1", toolName: "alpha", value: "first" }]),
        assistantCall("c2", "beta", 4),
        toolResult([{ toolCallId: "c2", toolName: "beta", value: "second" }]),
        assistantCall("c3", "gamma", 4),
        toolResult([{ toolCallId: "c3", toolName: "gamma", value: "third" }]),
    ];
    const out = cm.prepare(messages);
    // First two tool messages elided, last one kept verbatim.
    assert.equal(firstResultValue(out[2]), "[alpha result elided - re-call if needed]");
    assert.equal(firstResultValue(out[4]), "[beta result elided - re-call if needed]");
    assert.equal(firstResultValue(out[6]), "third");
    // toolCallId is preserved on an elided result.
    const elided = out[2].content as Array<{ toolCallId?: string }>;
    assert.equal(elided[0].toolCallId, "c1");
    // Assistant tool-call messages are untouched.
    assert.equal(out[1], messages[1]);
});

test("eviction rewrites every tool-result part of a multi-part tool message", () => {
    const { log } = makeLog();
    const cm = new ContextManager({
        contextLimit: undefined,
        keptToolResultCount: 1,
        slidingWindowPercentage: 0.7,
        systemPromptTokens: 0,
        log,
    });
    const messages: ModelMessage[] = [
        userText(4),
        toolResult([
            { toolCallId: "a", toolName: "one", value: "v1" },
            { toolCallId: "b", toolName: "two", value: "v2" },
        ]),
        toolResult([{ toolCallId: "c", toolName: "three", value: "v3" }]),
    ];
    const out = cm.prepare(messages);
    const parts = out[1].content as Array<{ toolName: string; output: { value: string } }>;
    assert.equal(parts[0].output.value, "[one result elided - re-call if needed]");
    assert.equal(parts[1].output.value, "[two result elided - re-call if needed]");
    assert.equal(firstResultValue(out[2]), "v3");
});

test("sliding window leaves the array unchanged when within budget", () => {
    const { log } = makeLog();
    const cm = new ContextManager({
        contextLimit: 10_000,
        keptToolResultCount: 3,
        slidingWindowPercentage: 0.7,
        systemPromptTokens: 0,
        log,
    });
    const messages: ModelMessage[] = [userText(4), userText(4), userText(4), userText(4)];
    const out = cm.prepare(messages);
    assert.deepEqual(out, messages);
});

test("sliding window keeps first two and tail, eliding the middle span", () => {
    const { log } = makeLog();
    const cm = new ContextManager({
        contextLimit: 100,
        keptToolResultCount: 3,
        slidingWindowPercentage: 0.5, // budget = 50 tokens
        systemPromptTokens: 0,
        log,
    });
    // Six messages of ~14 tokens each (40 chars → 10 + 4 overhead) = 84.
    const messages: ModelMessage[] = Array.from({ length: 6 }, () => userText(40));
    const out = cm.prepare(messages);
    assert.equal(out.length, 4);
    assert.equal(out[0], messages[0]);
    assert.equal(out[1], messages[1]);
    assert.equal(out[2].content, "[elided 3 messages]");
    assert.equal(out[3], messages[5]);
});

test("sliding window never orphans a tool result whose call was dropped", () => {
    const { log } = makeLog();
    const cm = new ContextManager({
        contextLimit: 120,
        keptToolResultCount: 10, // don't elide in this test
        slidingWindowPercentage: 0.5, // budget = 60 tokens
        systemPromptTokens: 0,
        log,
    });
    const messages: ModelMessage[] = [
        userText(4),
        userText(4),
        assistantCall("c1", "search", 400), // huge — gets dropped first
        toolResult([{ toolCallId: "c1", toolName: "search", value: "x".repeat(40) }]),
        assistantCall("c2", "lookup", 4),
        toolResult([{ toolCallId: "c2", toolName: "lookup", value: "yy" }]),
        userText(4),
    ];
    const out = cm.prepare(messages);
    // The dropped span expanded past the orphaned tool result (index 3),
    // so no kept tool-result references the dropped call id c1.
    const keptCallIds = new Set<string>();
    for (const m of out) {
        if (m.role === "tool" && Array.isArray(m.content)) {
            for (const part of m.content as Array<{ toolCallId?: string }>) {
                if (part.toolCallId) {
                    keptCallIds.add(part.toolCallId);
                }
            }
        }
    }
    assert.equal(keptCallIds.has("c1"), false);
    assert.equal(keptCallIds.has("c2"), true);
    assert.equal(out[2].content, "[elided 2 messages]");
});

test("sliding window is a no-op when the context limit is unknown", () => {
    const { log } = makeLog();
    const cm = new ContextManager({
        contextLimit: undefined,
        keptToolResultCount: 3,
        slidingWindowPercentage: 0.5,
        systemPromptTokens: 1_000_000,
        log,
    });
    const messages: ModelMessage[] = Array.from({ length: 6 }, () => userText(40));
    const out = cm.prepare(messages);
    assert.deepEqual(out, messages);
});

test("a large system prompt forces the window to drop messages", () => {
    const { log } = makeLog();
    const cm = new ContextManager({
        contextLimit: 100,
        keptToolResultCount: 3,
        slidingWindowPercentage: 0.7, // budget = 70 tokens
        systemPromptTokens: 80, // already over budget before any message
        log,
    });
    const messages: ModelMessage[] = Array.from({ length: 5 }, () => userText(4));
    const out = cm.prepare(messages);
    assert.ok(out.length < messages.length);
    assert.equal(out[2].content, "[elided 2 messages]");
});

test("sliding window leaves the array unchanged and warns when nothing is droppable", () => {
    const { log, warned } = makeLog();
    const cm = new ContextManager({
        contextLimit: 20,
        keptToolResultCount: 3,
        slidingWindowPercentage: 0.5, // budget = 10 tokens
        systemPromptTokens: 0,
        log,
    });
    // Only first-two + one tail: nothing between them to drop.
    const messages: ModelMessage[] = [userText(40), userText(40), userText(40)];
    const out = cm.prepare(messages);
    assert.equal(out, messages);
    assert.ok(warned());
});
