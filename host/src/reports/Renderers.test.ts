import assert from "node:assert";
import { describe, it } from "node:test";
import type { AgentRunRow, StepResultRow } from "@getfamiliar/shared";
import { renderStepResult } from "./Renderers.js";

function fakeRun(): AgentRunRow {
    return {
        id: "1",
        eventId: "10",
        parentAgentrunId: null,
        topic: "mail",
        handler: "index",
        model: "featherless/test",
        priority: 0,
        state: "running",
        prompt: null,
        systemPrompt: null,
        payload: null,
        result: null,
        resultText: null,
        error: null,
        privileged: false,
        calltype: null,
        retryCount: 0,
        notBefore: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
    } as unknown as AgentRunRow;
}

function fakeStep(over: Partial<StepResultRow>): StepResultRow {
    return {
        id: "1",
        agentRunId: "1",
        eventId: "10",
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

describe("renderStepResult — tool error rendering", () => {
    it("renders a matched tool-error as a blockquote with the flattened message", () => {
        const step = fakeStep({
            toolCalls: [
                { toolCallId: "c1", toolName: "mail_fetch_body", input: {} },
            ],
            toolResults: [
                {
                    type: "tool-error",
                    toolCallId: "c1",
                    toolName: "mail_fetch_body",
                    error: "MissingMailId: no mail_id given",
                },
            ],
        });
        const md = renderStepResult(fakeRun(), step);
        assert.match(md, /\*\*Tool call:\*\* `mail_fetch_body`/);
        assert.match(md, /> MissingMailId: no mail_id given/);
        // The failure path should not also emit an empty ```json output block.
        assert.equal(md.includes("```json\nundefined\n```"), false);
    });

    it("still renders successful tool-result calls with a JSON output block", () => {
        const step = fakeStep({
            toolCalls: [
                { toolCallId: "c1", toolName: "mail_fetch_body", input: { mail_id: "x" } },
            ],
            toolResults: [
                { type: "tool-result", toolCallId: "c1", output: "hello" },
            ],
        });
        const md = renderStepResult(fakeRun(), step);
        assert.match(md, /```json\n"hello"\n```/);
        assert.equal(md.includes("**Tool error:**"), false);
    });

    it("falls back to a generic label when error field is missing", () => {
        const step = fakeStep({
            toolCalls: [{ toolCallId: "c1", toolName: "x", input: {} }],
            toolResults: [{ type: "tool-error", toolCallId: "c1", toolName: "x" }],
        });
        const md = renderStepResult(fakeRun(), step);
        assert.match(md, /> tool error/);
    });
});
