import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { StepResultRow } from "@getfamiliar/shared";
import { formatStepProgress, PROGRESS_REASONING_CHARS } from "./StepProgress.js";

/**
 * A step row with the fields the formatter reads.
 *
 * @param fields Overrides.
 * @returns The row.
 */
function step(fields: Partial<StepResultRow>): StepResultRow {
    return {
        id: "1",
        agentRunId: "r1",
        eventId: "e1",
        stepNumber: 0,
        finishReason: "tool-calls",
        resultText: null,
        reasoningText: null,
        toolCalls: [],
        toolResults: [],
        ...fields,
    } as StepResultRow;
}

describe("formatStepProgress", () => {
    it("lists reasoning and tool calls, unwrapping the tool_call proxy", () => {
        const note = formatStepProgress(
            step({
                stepNumber: 2,
                reasoningText: "Ich  prüfe\nden Kalender.",
                toolCalls: [
                    {
                        toolCallId: "c1",
                        toolName: "tool_call",
                        input: {
                            name: "calendar_list_events",
                            arguments: { from_day: "2026-11-08" },
                        },
                    },
                    { toolCallId: "c2", toolName: "fs_read", input: { path: "people/x.md" } },
                ],
            }),
            1500,
        );
        assert.equal(
            note,
            'Background task progress (step 3): Thinking: Ich prüfe den Kalender. | Calling: calendar_list_events {"from_day":"2026-11-08"}; fs_read {"path":"people/x.md"}',
        );
    });

    it("lists failed tool calls", () => {
        const note = formatStepProgress(
            step({
                toolCalls: [{ toolCallId: "c1", toolName: "mail_search", input: {} }],
                toolResults: [{ type: "tool-error", toolCallId: "c1", error: "timeout" }],
            }),
            1500,
        );
        assert.match(note ?? "", /Failed: mail_search — timeout$/);
    });

    it("keeps the tail of long reasoning", () => {
        const reasoning = `${"anfang ".repeat(200)}nächster Schritt: Mail lesen.`;
        const note = formatStepProgress(step({ reasoningText: reasoning }), 1500) ?? "";
        assert.match(note, /Thinking: ….*nächster Schritt: Mail lesen\.$/);
        assert.ok(note.length < PROGRESS_REASONING_CHARS + 60);
    });

    it("falls back to the step text when there is no reasoning", () => {
        const note = formatStepProgress(
            step({
                resultText: "Ich schaue nach.",
                toolCalls: [{ toolCallId: "c1", toolName: "fs_read", input: {} }],
            }),
            1500,
        );
        assert.match(note ?? "", /Thinking: Ich schaue nach\./);
    });

    it("skips the final answer and send_chat-only steps", () => {
        assert.equal(
            formatStepProgress(step({ finishReason: "stop", resultText: "Morgen um 9." }), 1500),
            null,
        );
        assert.equal(
            formatStepProgress(
                step({
                    reasoningText: "Kurz Bescheid geben.",
                    toolCalls: [{ toolCallId: "c1", toolName: "send_chat", input: { text: "x" } }],
                }),
                1500,
            ),
            null,
        );
    });

    it("never exceeds the limit", () => {
        const note = formatStepProgress(
            step({
                reasoningText: "x ".repeat(1000),
                toolCalls: Array.from({ length: 30 }, (_, index) => ({
                    toolCallId: `c${index}`,
                    toolName: `tool_${index}`,
                    input: { query: "y".repeat(200) },
                })),
            }),
            300,
        );
        assert.ok(note !== null && note.length <= 300);
    });
});
