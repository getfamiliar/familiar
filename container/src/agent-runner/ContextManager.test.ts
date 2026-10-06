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

/** Spill stub recording every write and returning a predictable path. */
function makeSpill(): {
    spill: (name: string, contents: Buffer) => Promise<string>;
    writes: Array<{ name: string; contents: string }>;
} {
    const writes: Array<{ name: string; contents: string }> = [];
    return {
        writes,
        spill: async (name, contents) => {
            writes.push({ name, contents: contents.toString("utf8") });
            return `/scratch/ev/${writes.length}-${name}`;
        },
    };
}

/** Build a {@link ContextManager} with test defaults, overridable per test. */
function makeManager(
    overrides: Partial<ConstructorParameters<typeof ContextManager>[0]> = {},
): ContextManager {
    return new ContextManager({
        contextLimit: undefined,
        fallbackContextLimit: 1_000_000,
        thresholdPercentage: 0.7,
        systemPromptTokens: 0,
        spill: makeSpill().spill,
        log: makeLog().log,
        ...overrides,
    });
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

/** An assistant message issuing one tool call with the exact `input` given. */
function assistantCallWith(toolCallId: string, toolName: string, input: unknown): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId, toolName, input }],
    } as ModelMessage;
}

test("below the threshold nothing is elided, however many steps ran", async () => {
    const cm = makeManager({ contextLimit: 1_000_000 });
    const messages: ModelMessage[] = [userText(4)];
    for (let i = 0; i < 12; i++) {
        messages.push(assistantCall(`c${i}`, `tool${i}`, 4));
        messages.push(
            toolResult([{ toolCallId: `c${i}`, toolName: `tool${i}`, value: "r".repeat(4000) }]),
        );
    }
    const out = await cm.prepare(messages);
    assert.deepEqual(out, messages);
});

test("over the threshold the oldest large results move to scratch until usage fits", async () => {
    const { spill, writes } = makeSpill();
    // budget = 0.5 * 6000 = 3000 tokens; three results of ~2000 tokens each.
    const cm = makeManager({ contextLimit: 6000, thresholdPercentage: 0.5, spill });
    const messages: ModelMessage[] = [
        userText(4),
        assistantCall("c1", "alpha", 4),
        toolResult([{ toolCallId: "c1", toolName: "alpha", value: "a".repeat(8000) }]),
        assistantCall("c2", "beta", 4),
        toolResult([{ toolCallId: "c2", toolName: "beta", value: "b".repeat(8000) }]),
        assistantCall("c3", "gamma", 4),
        toolResult([{ toolCallId: "c3", toolName: "gamma", value: "c".repeat(8000) }]),
    ];
    const out = await cm.prepare(messages);
    const alpha = firstResultValue(out[2]);
    assert.match(alpha, /^\[alpha\(\{"q":"xxxx"\}\) result \(7\.8 KB\)/);
    assert.match(alpha, /moved to \/scratch\/ev\/1-tool-result-alpha\.txt/);
    assert.match(alpha, /Preview: a{300}…\]$/);
    assert.match(firstResultValue(out[4]), /^\[beta\(/);
    // The newest tool message is never touched.
    assert.equal(out[6], messages[6]);
    // Full results land on disk verbatim; no message dropped.
    assert.deepEqual(
        writes.map((w) => w.contents.length),
        [8000, 8000],
    );
    assert.equal(out.length, messages.length);
    // toolCallId is preserved; assistant calls untouched.
    assert.equal((out[2].content as Array<{ toolCallId?: string }>)[0].toolCallId, "c1");
    assert.equal(out[1], messages[1]);
});

test("eviction stops as soon as usage fits the budget", async () => {
    // budget = 0.5 * 9000 = 4500; three ~2000-token results → only the oldest goes.
    const cm = makeManager({ contextLimit: 9000, thresholdPercentage: 0.5 });
    const messages: ModelMessage[] = [
        userText(4),
        toolResult([{ toolCallId: "c1", toolName: "alpha", value: "a".repeat(8000) }]),
        toolResult([{ toolCallId: "c2", toolName: "beta", value: "b".repeat(8000) }]),
        toolResult([{ toolCallId: "c3", toolName: "gamma", value: "c".repeat(8000) }]),
    ];
    const out = await cm.prepare(messages);
    assert.match(firstResultValue(out[1]), /^\[alpha\(\) result/);
    assert.equal(out[2], messages[2]);
    assert.equal(out[3], messages[3]);
});

test("small results are never evicted, even over budget", async () => {
    const cm = makeManager({ contextLimit: 100, thresholdPercentage: 0.5 });
    const messages: ModelMessage[] = [
        userText(4),
        toolResult([{ toolCallId: "c1", toolName: "whoop", value: "w".repeat(400) }]),
        toolResult([{ toolCallId: "c2", toolName: "weather", value: "v".repeat(400) }]),
        userText(4),
    ];
    const out = await cm.prepare(messages);
    for (const m of out) {
        if (m.role === "tool") {
            assert.doesNotMatch(firstResultValue(m), /^\[/);
        }
    }
});

test("unknown context limit evicts against the fallback limit", async () => {
    const cm = makeManager({
        contextLimit: undefined,
        fallbackContextLimit: 6000,
        thresholdPercentage: 0.5,
    });
    const messages: ModelMessage[] = [
        userText(4),
        toolResult([{ toolCallId: "c1", toolName: "alpha", value: "a".repeat(8000) }]),
        toolResult([{ toolCallId: "c2", toolName: "beta", value: "b".repeat(8000) }]),
    ];
    const out = await cm.prepare(messages);
    assert.match(firstResultValue(out[1]), /^\[alpha\(\) result/);
    assert.equal(out[2], messages[2]);
});

test("older results of identical calls go to scratch regardless of budget", async () => {
    const { spill, writes } = makeSpill();
    const cm = makeManager({ contextLimit: 1_000_000, spill });
    const input = { day: "2026-10-06" };
    const messages: ModelMessage[] = [
        userText(4),
        assistantCallWith("c1", "cal_get_events", input),
        toolResult([{ toolCallId: "c1", toolName: "cal_get_events", value: "e".repeat(2000) }]),
        assistantCallWith("c2", "cal_get_events", { day: "2026-10-07" }),
        toolResult([{ toolCallId: "c2", toolName: "cal_get_events", value: "f".repeat(2000) }]),
        assistantCallWith("c3", "cal_get_events", input),
        toolResult([{ toolCallId: "c3", toolName: "cal_get_events", value: "g".repeat(2000) }]),
    ];
    const out = await cm.prepare(messages);
    assert.match(firstResultValue(out[2]), /^\[cal_get_events\(\{"day":"2026-10-06"\}\) result/);
    // Different arguments are not a duplicate; the newest copy stays.
    assert.equal(out[4], messages[4]);
    assert.equal(out[6], messages[6]);
    assert.equal(writes.length, 1);
});

test("each result is spilled once and the path is reused on later steps", async () => {
    const { spill, writes } = makeSpill();
    const cm = makeManager({ contextLimit: 1_000_000, spill });
    const messages: ModelMessage[] = [
        userText(4),
        assistantCallWith("c1", "search", { q: "a" }),
        toolResult([{ toolCallId: "c1", toolName: "search", value: "s".repeat(2000) }]),
        assistantCallWith("c2", "search", { q: "a" }),
        toolResult([{ toolCallId: "c2", toolName: "search", value: "s".repeat(2000) }]),
    ];
    const first = await cm.prepare(messages);
    const second = await cm.prepare(messages);
    assert.equal(writes.length, 1);
    assert.equal(firstResultValue(first[2]), firstResultValue(second[2]));
});

test("a failed spill still elides, saying the result could not be saved", async () => {
    const { log, warned } = makeLog();
    const cm = makeManager({
        contextLimit: 1_000_000,
        log,
        spill: async () => {
            throw new Error("disk full");
        },
    });
    const messages: ModelMessage[] = [
        userText(4),
        assistantCallWith("c1", "search", { q: "a" }),
        toolResult([{ toolCallId: "c1", toolName: "search", value: "s".repeat(2000) }]),
        assistantCallWith("c2", "search", { q: "a" }),
        toolResult([{ toolCallId: "c2", toolName: "search", value: "s".repeat(2000) }]),
    ];
    const out = await cm.prepare(messages);
    assert.match(firstResultValue(out[2]), /saving it to scratch failed/);
    assert.ok(warned());
});

test("eviction rewrites every selected part of a multi-part tool message", async () => {
    const cm = makeManager({ contextLimit: 3000, thresholdPercentage: 0.5 });
    const messages: ModelMessage[] = [
        userText(4),
        toolResult([
            { toolCallId: "a", toolName: "one", value: "1".repeat(8000) },
            { toolCallId: "b", toolName: "two", value: "2".repeat(8000) },
        ]),
        toolResult([{ toolCallId: "c", toolName: "three", value: "v3" }]),
    ];
    const out = await cm.prepare(messages);
    const parts = out[1].content as Array<{ output: { value: string } }>;
    assert.match(parts[0].output.value, /^\[one\(\) result/);
    assert.match(parts[1].output.value, /^\[two\(\) result/);
    assert.equal(firstResultValue(out[2]), "v3");
});

test("repeated-call notice appears from the third identical call in the latest step", () => {
    const cm = makeManager();
    const input = { jql: "assignee=me" };
    const twice: ModelMessage[] = [
        userText(4),
        assistantCallWith("c1", "at_jira_search", input),
        toolResult([{ toolCallId: "c1", toolName: "at_jira_search", value: "x" }]),
        assistantCallWith("c2", "at_jira_search", input),
        toolResult([{ toolCallId: "c2", toolName: "at_jira_search", value: "x" }]),
    ];
    assert.equal(cm.buildRepeatedCallNotice(twice), null);
    const thrice: ModelMessage[] = [
        ...twice,
        assistantCallWith("c3", "at_jira_search", input),
        toolResult([{ toolCallId: "c3", toolName: "at_jira_search", value: "x" }]),
    ];
    assert.match(cm.buildRepeatedCallNotice(thrice) ?? "", /at_jira_search \(3×\)/);
    // Once the agent moves on to another call, the notice goes away.
    const movedOn: ModelMessage[] = [
        ...thrice,
        assistantCallWith("c4", "weather_get_forecast", { days: 1 }),
        toolResult([{ toolCallId: "c4", toolName: "weather_get_forecast", value: "x" }]),
    ];
    assert.equal(cm.buildRepeatedCallNotice(movedOn), null);
});

test("sliding window leaves the array unchanged when within budget", async () => {
    const cm = makeManager({
        contextLimit: 10_000,
        thresholdPercentage: 0.7,
        systemPromptTokens: 0,
    });
    const messages: ModelMessage[] = [userText(4), userText(4), userText(4), userText(4)];
    const out = await cm.prepare(messages);
    assert.deepEqual(out, messages);
});

test("sliding window keeps first two and tail, eliding the middle span", async () => {
    const cm = makeManager({
        contextLimit: 100,
        thresholdPercentage: 0.5, // budget = 50 tokens
        systemPromptTokens: 0,
    });
    // Six messages of ~14 tokens each (40 chars → 10 + 4 overhead) = 84.
    const messages: ModelMessage[] = Array.from({ length: 6 }, () => userText(40));
    const out = await cm.prepare(messages);
    assert.equal(out.length, 4);
    assert.equal(out[0], messages[0]);
    assert.equal(out[1], messages[1]);
    assert.equal(out[2].content, "[elided 3 messages]");
    assert.equal(out[3], messages[5]);
});

test("sliding window never orphans a tool result whose call was dropped", async () => {
    const cm = makeManager({
        contextLimit: 120,
        thresholdPercentage: 0.5, // budget = 60 tokens
        systemPromptTokens: 0,
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
    const out = await cm.prepare(messages);
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

test("sliding window is a no-op when the context limit is unknown", async () => {
    const cm = makeManager({
        contextLimit: undefined,
        thresholdPercentage: 0.5,
        systemPromptTokens: 1_000_000,
    });
    const messages: ModelMessage[] = Array.from({ length: 6 }, () => userText(40));
    const out = await cm.prepare(messages);
    assert.deepEqual(out, messages);
});

test("a large system prompt forces the window to drop messages", async () => {
    const cm = makeManager({
        contextLimit: 100,
        thresholdPercentage: 0.7, // budget = 70 tokens
        systemPromptTokens: 80, // already over budget before any message
    });
    const messages: ModelMessage[] = Array.from({ length: 5 }, () => userText(4));
    const out = await cm.prepare(messages);
    assert.ok(out.length < messages.length);
    assert.equal(out[2].content, "[elided 2 messages]");
});

test("sliding window leaves the array unchanged and warns when nothing is droppable", async () => {
    const { log, warned } = makeLog();
    const cm = makeManager({
        contextLimit: 20,
        thresholdPercentage: 0.5, // budget = 10 tokens
        systemPromptTokens: 0,
        log,
    });
    // Only first-two + one tail: nothing between them to drop.
    const messages: ModelMessage[] = [userText(40), userText(40), userText(40)];
    const out = await cm.prepare(messages);
    assert.equal(out, messages);
    assert.ok(warned());
});
