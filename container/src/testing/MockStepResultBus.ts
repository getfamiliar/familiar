import type { NewStepResult, StepResultRow } from "@getfamiliar/shared";

/**
 * In-memory {@link StepResultBus} replacement for unit tests. Most
 * Scheduler tests don't assert on per-step state; this mock exists
 * so the Scheduler can record steps without a postgres connection.
 */
export class MockStepResultBus {
    readonly rows: StepResultRow[] = [];
    private nextId = 1;

    async add(input: NewStepResult): Promise<StepResultRow> {
        const id = String(this.nextId++);
        const calls = Array.isArray(input.toolCalls) ? input.toolCalls.length : 0;
        const total =
            input.inputTokens != null && input.outputTokens != null
                ? input.inputTokens + input.outputTokens
                : null;
        const row: StepResultRow = {
            id,
            agentRunId: input.agentRunId,
            eventId: input.eventId,
            stepNumber: input.stepNumber,
            finishReason: input.finishReason,
            resultText: input.resultText ?? null,
            reasoningText: input.reasoningText ?? null,
            inputTokens: input.inputTokens ?? null,
            outputTokens: input.outputTokens ?? null,
            totalTokens: total,
            inputTokensNoCache: input.inputTokensNoCache ?? null,
            inputTokensCacheRead: input.inputTokensCacheRead ?? null,
            inputTokensCacheWrite: input.inputTokensCacheWrite ?? null,
            outputTokensText: input.outputTokensText ?? null,
            outputTokensReasoning: input.outputTokensReasoning ?? null,
            toolCallCount: calls,
            toolCalls: input.toolCalls ?? [],
            toolResults: input.toolResults ?? [],
            rawResult: input.rawResult ?? null,
            createdAt: new Date(),
        };
        this.rows.push(row);
        return row;
    }
}
