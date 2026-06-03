import assert from "node:assert";
import { describe, it } from "node:test";
import type { AgentRunRow, EventRow, StepResultRow } from "@getfamiliar/shared";
import { renderAgentrunReport, renderEventReport } from "./Renderers.js";

function fakeEvent(over: Partial<EventRow> = {}): EventRow {
    return {
        id: "302",
        topic: "chat:cli",
        priority: 100,
        state: "done",
        payload: { abc: "def" },
        idempotencyKey: null,
        isChat: true,
        preferredChatChannelId: "cli",
        prompt: "hello there",
        startHandler: null,
        privileged: true,
        outputChatOnFailure: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...over,
    } as EventRow;
}

function fakeRun(over: Partial<AgentRunRow>): AgentRunRow {
    return {
        id: "3289",
        eventId: "302",
        parentAgentrunId: null,
        topic: "chat:cli",
        handler: "index",
        model: "featherless/x",
        priority: 100,
        state: "done",
        prompt: null,
        systemPrompt: null,
        initialMessages: null,
        payload: null,
        result: null,
        resultText: null,
        error: null,
        privileged: true,
        calltype: null,
        retryCount: 0,
        notBefore: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...over,
    } as AgentRunRow;
}

function fakeStep(over: Partial<StepResultRow>): StepResultRow {
    return {
        id: "1",
        agentRunId: "3289",
        eventId: "302",
        stepNumber: 0,
        finishReason: "tool-calls",
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
        toolCalls: [],
        toolResults: [],
        rawResult: null,
        createdAt: new Date(0),
        ...over,
    } as StepResultRow;
}

/**
 * Build a representative tree:
 *   root #3289 (done)
 *     step01: thinking + fs_read
 *     step02: call_handler  -> child #3290 (called, done)
 *                                 step01: call_handler -> grandchild #3293 (called, done)
 *     step03: schedule_handler (immediate -> #3291 queued/pending),
 *             schedule_handler (deferred -> placeholder)
 *     step04: stop
 *   orphan #3294 (called, done) — no matching tool call
 */
function buildTree(): {
    event: EventRow;
    runs: AgentRunRow[];
    stepsByRun: Map<string, readonly StepResultRow[]>;
} {
    const event = fakeEvent();
    const root = fakeRun({
        id: "3289",
        resultText: "the final answer",
        systemPrompt: "SYSTEM PROMPT BODY",
        initialMessages: [{ role: "user", content: "hi" }],
    });
    const child = fakeRun({
        id: "3290",
        parentAgentrunId: "3289",
        handler: "respond",
        calltype: "called",
        resultText: "respond done",
    });
    const grandchild = fakeRun({
        id: "3293",
        parentAgentrunId: "3290",
        handler: "summarize",
        calltype: "called",
        resultText: "grandchild done",
    });
    const immediate = fakeRun({
        id: "3291",
        parentAgentrunId: "3289",
        handler: "notify",
        calltype: "queued",
        state: "pending",
    });
    const orphan = fakeRun({
        id: "3294",
        parentAgentrunId: "3289",
        handler: "stray",
        calltype: "called",
        resultText: "orphan done",
    });

    const stepsByRun = new Map<string, readonly StepResultRow[]>();
    stepsByRun.set("3289", [
        fakeStep({
            id: "s0",
            stepNumber: 0,
            reasoningText: "thinking one",
            totalTokens: 100,
            inputTokensCacheRead: 30,
            inputTokensNoCache: 20,
            outputTokensText: 10,
            outputTokensReasoning: 5,
            toolCalls: [{ toolCallId: "c1", toolName: "fs_read", input: { path: "a.md" } }],
            toolResults: [{ type: "tool-result", toolCallId: "c1", output: "file contents here" }],
        }),
        fakeStep({
            id: "s1",
            stepNumber: 1,
            toolCalls: [
                { toolCallId: "c2", toolName: "call_handler", input: { handler: "respond" } },
            ],
            toolResults: [{ type: "tool-result", toolCallId: "c2", output: "respond done" }],
        }),
        fakeStep({
            id: "s2",
            stepNumber: 2,
            toolCalls: [
                { toolCallId: "c3", toolName: "schedule_handler", input: { handler: "notify" } },
                { toolCallId: "c4", toolName: "schedule_handler", input: { handler: "digest" } },
            ],
            toolResults: [
                { type: "tool-result", toolCallId: "c3", output: { agentrunId: "3291" } },
                {
                    type: "tool-result",
                    toolCallId: "c4",
                    output: { key: "k1", when: "2026-05-30 11:30:00" },
                },
            ],
        }),
        fakeStep({ id: "s3", stepNumber: 3, finishReason: "stop" }),
    ]);
    stepsByRun.set("3290", [
        fakeStep({
            id: "s10",
            agentRunId: "3290",
            stepNumber: 0,
            toolCalls: [
                { toolCallId: "g1", toolName: "call_handler", input: { handler: "summarize" } },
            ],
            toolResults: [{ type: "tool-result", toolCallId: "g1", output: "grandchild done" }],
        }),
    ]);
    stepsByRun.set("3293", [
        fakeStep({ id: "s20", agentRunId: "3293", stepNumber: 0, finishReason: "stop" }),
    ]);
    stepsByRun.set("3294", [
        fakeStep({ id: "s30", agentRunId: "3294", stepNumber: 0, finishReason: "stop" }),
    ]);

    return { event, runs: [root, child, grandchild, immediate, orphan], stepsByRun };
}

describe("renderEventReport — structure & correlation", () => {
    it("renders the event header and field table in the new order", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.match(md, /# Event #302 \(created 1970-01-01 \d{2}:\d{2}:\d{2}\)/);
        assert.match(md, /\| Topic \| `chat:cli` \|/);
        assert.match(md, /\| Start Handler \| <default> \|/);
        assert.match(md, /\| Output is Chat Message \| yes \|/);
        assert.match(md, /\| Preferred Chat Channel \| cli \|/);
        assert.match(md, /\| Idempotency Key \| — \|/);
        assert.match(md, /\| State \| Done \|/);
        assert.match(md, /\*\*Prompt:\*\*\n\n> hello there/);
        assert.match(md, /\*\*Payload:\*\*\n\n```json/);
    });

    it("renders the root agentrun block and numbered step protocol", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.match(md, /## Root agentrun #3289 \(started 1970-01-01/);
        assert.match(md, /Using handler `chat:cli\/index` with model `featherless\/x`\./);
        assert.match(md, /### Step Protocol/);
        assert.match(md, /01\. Step/);
        assert.match(md, / {4}Thinking: __thinking one__/);
        assert.match(md, / {4}tool_call: fs_read/);
        assert.match(md, /02\. Step/);
        assert.match(md, /04\. Step/);
        assert.match(md, / {4}stop/);
    });

    it("nests a called subagent inline as a blockquote after its step", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.match(md, /> ### Agentrun #3290 \(started 1970-01-01/);
        // Blank lines inside the quote are a bare ">" (not "> "), so the
        // blockquote survives the heading -> body boundary.
        assert.match(md, /> ### Agentrun #3290 \(started[^\n]*\n>\n/);
    });

    it("double-prefixes a grandchild (call_handler within a called child)", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.match(md, /> > ### Agentrun #3293 \(started 1970-01-01/);
    });

    it("matches an immediate schedule child by id and renders its pending stub", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.match(md, /> ### Agentrun #3291 \(queued for execution\)/);
    });

    it("renders a deferred schedule as an inline placeholder, no child block", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.match(md, /> ### Scheduled handler `digest` — wakeup at 2026-05-30 11:30:00/);
    });

    it("renders an uncorrelated child as an orphan after the last step", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.match(md, /> _\(could not correlate to a tool call\)_/);
        assert.match(md, /> ### Agentrun #3294 \(started 1970-01-01/);
    });

    it("renders the event-level final result", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.match(md, /## Final Result\n\n> the final answer/);
    });

    it("closes a finished event with the token total across the whole tree", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        // Only the root's first step carries usage (total 100, breakdown 30/20/10/5).
        assert.match(
            md,
            /\*\*Tokens used across the event:\*\* 100 \(30 cached in \+ 20 in \+ 10 text out \+ 5 reasoning out\)/,
        );
        // It sits below the final result.
        assert.ok(md.indexOf("Tokens used across the event") > md.indexOf("## Final Result"));
    });

    it("level 0 omits token suffix, system prompt, and message history", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.ok(!md.includes("tokens total"));
        assert.ok(!md.includes("**System Prompt:**"));
        assert.ok(!md.includes("**Initial message history:**"));
        assert.ok(!md.includes("```javascript"));
    });
});

describe("renderEventReport — verbosity levels", () => {
    it("level 1 adds the token suffix and the system prompt", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 1, truncate: false });
        assert.match(
            md,
            /\*\*01\. Step:\*\* __\(100 tokens total: 30 cached in \+ 20 in \+ 10 text out \+ 5 reasoning out\)__/,
        );
        assert.match(md, /\*\*System Prompt:\*\*\n\n> SYSTEM PROMPT BODY/);
        assert.ok(!md.includes("**Initial message history:**"));
    });

    it("level 2 adds tool I/O blocks and the initial message history", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 2, truncate: false });
        assert.match(md, /\*\*Initial message history:\*\*/);
        assert.match(md, /\* `\[user\]`: hi/);
        assert.match(md, /```javascript/);
        // String tool output renders as a backtick template, preserving text.
        assert.match(md, /fs_read\(\{[\s\S]*?\}\) => `\nfile contents here\n`/);
        // Object tool output renders as JSON.
        assert.match(md, /schedule_handler\([\s\S]*?\) => \{\n\s+"agentrunId": "3291"\n\}/);
    });

    it("level 2 shows the not-recorded note when initial_messages is null", () => {
        const { event, runs, stepsByRun } = buildTree();
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 2, truncate: false });
        // The child #3290 has no captured initial messages.
        assert.match(
            md,
            /_Not recorded\. Set inference\.captureInitialMessageHistory to true in the config to enable recording\._/,
        );
    });
});

describe("renderEventReport — truncation & pending", () => {
    it("truncate:true caps long prose; truncate:false keeps it", () => {
        const longPrompt = "x".repeat(400);
        const event = fakeEvent({ prompt: longPrompt });
        const runs = [fakeRun({ id: "1", resultText: "ok" })];
        const stepsByRun = new Map<string, readonly StepResultRow[]>([["1", []]]);

        const truncated = renderEventReport(event, runs, stepsByRun, {
            verbosity: 0,
            truncate: true,
        });
        const full = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.ok(truncated.includes("…"));
        assert.ok(!truncated.includes(longPrompt));
        assert.ok(full.includes(longPrompt));
    });

    it("a still-running root shows a pending final result", () => {
        const event = fakeEvent({ state: "running" });
        const runs = [fakeRun({ id: "1", state: "running", resultText: null })];
        const stepsByRun = new Map<string, readonly StepResultRow[]>([["1", []]]);
        const md = renderEventReport(event, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.match(md, /## Final Result\n\n> __still pending__/);
        assert.match(md, /_\(no steps recorded\)_/);
        // No event-wide token total until the event settles.
        assert.ok(!md.includes("Tokens used across the event"));
    });
});

describe("renderAgentrunReport", () => {
    it("renders a single agentrun subtree without the event header", () => {
        const { runs, stepsByRun } = buildTree();
        const root = runs[0];
        const md = renderAgentrunReport(root, runs, stepsByRun, { verbosity: 0, truncate: false });
        assert.ok(!md.includes("# Event #"));
        assert.match(md, /## Agentrun #3289 \(started 1970-01-01/);
        // Descendants still nest inline.
        assert.match(md, /> ### Agentrun #3290 \(started 1970-01-01/);
        assert.match(md, /## Final Result\n\n> the final answer/);
    });
});
