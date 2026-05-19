import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunRow, StepResultRow } from "@getfamiliar/shared";
import type { Ora } from "ora";
import { formatStepLines, RunRenderer, type SpinnerFactory } from "./RunRenderer.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
    return s.replace(ANSI_RE, "");
}

function makeStep(overrides: Partial<StepResultRow> = {}): StepResultRow {
    return {
        id: "1",
        agentRunId: "10",
        eventId: "100",
        stepNumber: 0,
        finishReason: "stop",
        resultText: null,
        reasoningText: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        inputTokensNoCache: null,
        inputTokensCacheRead: null,
        inputTokensCacheWrite: null,
        outputTokensText: null,
        outputTokensReasoning: null,
        toolCallCount: 0,
        toolCalls: null,
        toolResults: null,
        rawResult: null,
        createdAt: new Date(),
        ...overrides,
    };
}

function makeRun(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
    return {
        id: "100",
        eventId: "35",
        parentAgentrunId: null,
        topic: "chat:cli",
        handler: "index",
        priority: 50,
        state: "pending",
        prompt: null,
        payload: {},
        result: null,
        resultText: null,
        error: null,
        privileged: true,
        retryCount: 0,
        notBefore: null,
        model: null,
        systemPrompt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

/**
 * Stub ora instance that records every text/suffix/symbol mutation
 * the renderer performs so a test can assert on the transitions
 * without depending on stdout or timers.
 */
interface MockSpinnerCalls {
    initialText: string;
    textHistory: string[];
    suffixHistory: string[];
    persisted: Array<{ symbol?: string; text?: string }>;
    stopped: boolean;
}

function createMockFactory(): { factory: SpinnerFactory; instances: MockSpinnerCalls[] } {
    const instances: MockSpinnerCalls[] = [];
    const factory: SpinnerFactory = (text) => {
        const calls: MockSpinnerCalls = {
            initialText: text,
            textHistory: [text],
            suffixHistory: [],
            persisted: [],
            stopped: false,
        };
        instances.push(calls);
        let currentText = text;
        let currentSuffix = "";
        let spinning = true;
        const spinner: Ora = {
            get text() {
                return currentText;
            },
            set text(value: string) {
                currentText = value;
                calls.textHistory.push(value);
            },
            get suffixText() {
                return currentSuffix;
            },
            set suffixText(value: string) {
                currentSuffix = value;
                calls.suffixHistory.push(value);
            },
            get isSpinning() {
                return spinning;
            },
            stopAndPersist(options: { symbol?: string; text?: string } = {}) {
                calls.persisted.push(options);
                calls.stopped = true;
                spinning = false;
                return spinner;
            },
            stop() {
                calls.stopped = true;
                spinning = false;
                return spinner;
            },
        } as unknown as Ora;
        return spinner;
    };
    return { factory, instances };
}

test("formatStepLines prefers reasoning text", () => {
    const lines = formatStepLines(
        makeStep({ stepNumber: 0, reasoningText: "User wants me to list files." }),
    );
    assert.deepEqual(lines, [`  ↳ 1. "User wants me to list files."`]);
});

test("formatStepLines falls back to resultText when reasoning is absent (non-stop step)", () => {
    const lines = formatStepLines(
        makeStep({
            stepNumber: 1,
            finishReason: "tool-calls",
            resultText: "Here is the answer.",
        }),
    );
    assert.deepEqual(lines, [`  ↳ 2. "Here is the answer."`]);
});

test("formatStepLines surfaces finishReason when both reasoning and text are empty", () => {
    const lines = formatStepLines(makeStep({ stepNumber: 0, finishReason: "tool-calls" }));
    assert.deepEqual(lines, ["  ↳ 1. tool-calls"]);
});

test("formatStepLines appends a tool_calls line when tools were used alongside reasoning", () => {
    const lines = formatStepLines(
        makeStep({
            stepNumber: 0,
            finishReason: "tool-calls",
            reasoningText: "look at the files",
            toolCalls: [{ toolName: "file_read" }, { toolName: "fs_glob" }],
        }),
    );
    assert.deepEqual(lines, [
        `  ↳ 1. "look at the files"`,
        "       tool_calls: file_read, fs_glob",
    ]);
});

test("formatStepLines drops the final 'stop' step when there is no reasoning text", () => {
    const lines = formatStepLines(
        makeStep({
            stepNumber: 4,
            finishReason: "stop",
            resultText: "Done — the chat answer goes through chat.subscribe, not here.",
        }),
    );
    assert.deepEqual(lines, []);
});

test("formatStepLines puts tool_calls inline when reasoning and text are both absent", () => {
    const lines = formatStepLines(
        makeStep({
            stepNumber: 0,
            finishReason: "tool-calls",
            toolCalls: [{ toolName: "calendar_send_invitation" }],
        }),
    );
    assert.deepEqual(lines, ["  ↳ 1. tool_calls: calendar_send_invitation"]);
});

test("happy path: eventQueued → pending → running → step → done updates spinner text and suffix", () => {
    const { factory, instances } = createMockFactory();
    const r = new RunRenderer(true, factory);

    r.eventQueued("35");
    assert.equal(instances.length, 1, "spinner started by eventQueued");
    assert.equal(stripAnsi(instances[0].initialText), "message queued as event #35");

    r.agentRun(makeRun({ id: "100", eventId: "35", state: "pending" }));
    assert.deepEqual(
        instances[0].textHistory.map(stripAnsi),
        ["message queued as event #35", "agentrun #100 queued for event #35"],
        "pending notification mutates spinner text",
    );

    r.agentRun(
        makeRun({
            id: "100",
            eventId: "35",
            state: "running",
            model: "featherless/test-model",
        }),
    );
    assert.equal(
        stripAnsi(instances[0].textHistory.at(-1) ?? ""),
        "agentrun #100 started for event #35",
        "running transition keeps the agentrun-status format",
    );

    r.step(makeStep({ agentRunId: "100", eventId: "35", reasoningText: "checking files" }));
    assert.ok(
        stripAnsi(instances[0].suffixHistory.at(-1) ?? "").includes(`↳ 1. "checking files"`),
        "step is appended to suffix",
    );

    r.agentRun(
        makeRun({
            id: "100",
            eventId: "35",
            state: "done",
            model: "featherless/test-model",
        }),
    );
    assert.equal(instances[0].persisted.length, 1, "spinner is persisted on done");
    assert.ok(instances[0].persisted[0].symbol?.includes("✔"), "persisted with the check symbol");
});

test("agentRun firing before eventQueued (emit-await race) keeps the agentrun text", () => {
    const { factory, instances } = createMockFactory();
    const r = new RunRenderer(true, factory);

    // Simulate the race: container inserted the agentrun row before
    // the host code reached `renderer.eventQueued(handle.id)`.
    r.agentRun(makeRun({ id: "100", eventId: "35", state: "pending" }));
    assert.equal(instances.length, 1, "agentRun starts a spinner when none exists yet");
    assert.equal(stripAnsi(instances[0].initialText), "agentrun #100 queued for event #35");

    r.eventQueued("35");
    assert.equal(instances.length, 1, "eventQueued is a no-op once a spinner exists");
    assert.equal(
        stripAnsi(instances[0].textHistory.at(-1) ?? ""),
        "agentrun #100 queued for event #35",
        "spinner text is not regressed to the less-informative 'message queued'",
    );
});

test("child agentrun succeeds the parent spinner and starts a fresh block", () => {
    const { factory, instances } = createMockFactory();
    const r = new RunRenderer(true, factory);

    r.eventQueued("35");
    r.agentRun(makeRun({ id: "100", eventId: "35", state: "pending" }));
    r.agentRun(
        makeRun({
            id: "100",
            eventId: "35",
            state: "running",
            model: "featherless/parent",
        }),
    );
    r.agentRun(
        makeRun({
            id: "100",
            eventId: "35",
            state: "done",
            model: "featherless/parent",
        }),
    );
    assert.equal(instances.length, 1);
    assert.equal(instances[0].persisted.length, 1);

    r.agentRun(
        makeRun({
            id: "101",
            eventId: "35",
            parentAgentrunId: "100",
            topic: "chat:cli",
            handler: "scheduler",
            state: "pending",
        }),
    );
    assert.equal(instances.length, 2, "child agentrun spawns a new spinner");
    assert.match(
        stripAnsi(instances[1].initialText),
        /agentrun #101 with handler `chat\/cli\/scheduler\.md` queued for event #35/,
    );
});

test("chatAnswer appends rendered markdown with trailing blank-line margin", () => {
    const { factory, instances } = createMockFactory();
    const r = new RunRenderer(false, factory);

    r.eventQueued("35");
    r.chatAnswer("Hello!\n\n");
    const finalSuffix = instances[0].suffixHistory.at(-1) ?? "";
    assert.ok(finalSuffix.endsWith("\n"), "suffix ends with a blank line for prompt margin");
    assert.ok(finalSuffix.includes("Hello!"), "rendered body is in the suffix");
    assert.ok(!finalSuffix.includes("Hello!\n\n"), "trailing answer whitespace was trimmed");
});
