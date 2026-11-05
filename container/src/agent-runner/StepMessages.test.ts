import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@getfamiliar/shared";
import type { ModelMessage } from "ai";
import { ContextManager } from "./ContextManager.js";
import { buildStepMessages } from "./StepMessages.js";
import { LAST_TURN_NOTICE } from "./stepBudgetNotice.js";

/** Logger stub that discards everything. */
function makeLog(): Logger {
    const noop = () => {};
    const stub = { debug: noop, info: noop, warn: noop, error: noop, child: () => stub };
    return stub as unknown as Logger;
}

/** A {@link ContextManager} with a generous budget, so it passes history through. */
function makeManager(): ContextManager {
    return new ContextManager({
        contextLimit: undefined,
        fallbackContextLimit: 1_000_000,
        thresholdPercentage: 0.7,
        systemPromptTokens: 0,
        spill: async (name) => `/scratch/ev/${name}`,
        log: makeLog(),
    });
}

/** One assistant tool call plus its tool result, as the SDK appends per step. */
function stepResponse(index: number): ModelMessage[] {
    const toolCallId = `call-${index}`;
    return [
        {
            role: "assistant",
            content: [
                {
                    type: "tool-call",
                    toolCallId,
                    toolName: "fs_read",
                    input: { path: `f${index}.md` },
                },
            ],
        },
        {
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    toolCallId,
                    toolName: "fs_read",
                    output: { type: "text", value: `contents ${index}` },
                },
            ],
        },
    ];
}

/** Count user messages whose text content equals `text`. */
function countUserText(messages: ReadonlyArray<ModelMessage>, text: string): number {
    return messages.filter((m) => m.role === "user" && m.content === text).length;
}

test("notices stay ephemeral across steps instead of carrying forward", async () => {
    const maxSteps = 5;
    const deps = { contextManager: makeManager(), maxSteps, log: makeLog() };
    const initialMessages: ModelMessage[] = [{ role: "user", content: "do the thing" }];
    const responseMessages: ModelMessage[] = [];

    let lastSent: ModelMessage[] = [];
    for (let stepNumber = 0; stepNumber < maxSteps; stepNumber++) {
        lastSent = await buildStepMessages({ stepNumber, initialMessages, responseMessages }, deps);
        responseMessages.push(...stepResponse(stepNumber));
    }

    // Last step: history + exactly one last-turn notice, no stacked countdowns.
    assert.equal(countUserText(lastSent, LAST_TURN_NOTICE), 1);
    const countdowns = lastSent.filter(
        (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.startsWith("You have only"),
    );
    assert.equal(countdowns.length, 0);
    // Every message except the trailing notice is the untouched history.
    assert.equal(lastSent.length, initialMessages.length + (maxSteps - 1) * 2 + 1);
});

test("no notice is added while the agent has runway", async () => {
    const deps = { contextManager: makeManager(), maxSteps: 15, log: makeLog() };
    const initialMessages: ModelMessage[] = [{ role: "user", content: "hi" }];
    const sent = await buildStepMessages(
        { stepNumber: 0, initialMessages, responseMessages: stepResponse(0) },
        deps,
    );
    assert.deepEqual(sent, [...initialMessages, ...stepResponse(0)]);
});
