/**
 * One row in the `stepresults` audit table — a single step inside an
 * {@link AgentRunRow}'s tool-loop.
 *
 * Steps are immutable: the row is INSERTed once when the AI SDK's
 * `onStepFinish` callback fires, and never updated.
 *
 * `id`, `agentRunId`, and `eventId` are kept as strings because
 * postgres `bigint` exceeds JavaScript's safe integer range.
 */
export interface StepResultRow {
    /** Database primary key. */
    readonly id: string;
    /** FK to {@link AgentRunRow.id} — the agentrun this step belongs to. */
    readonly agentRunId: string;
    /**
     * FK to {@link EventRow.id} — denormalized from the agentrun so
     * subscribers can route on the channel payload without a JOIN.
     */
    readonly eventId: string;
    /** Zero-based index of this step within its agentrun. */
    readonly stepNumber: number;
    /**
     * `'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error'
     * | 'other'` per the AI SDK's `FinishReason`. Stored as text so
     * forward-compatible with new SDK values.
     */
    readonly finishReason: string;
    /** The assistant text generated in this step (may be empty when only tool calls were made). */
    readonly resultText: string | null;
    /** Text-form chain-of-thought from extended-thinking models, when emitted. */
    readonly reasoningText: string | null;
    /** Prompt / input tokens for this step. SDK marks this `number | undefined`. */
    readonly inputTokens: number | null;
    /** Completion / output tokens for this step. SDK marks this `number | undefined`. */
    readonly outputTokens: number | null;
    /** `inputTokens + outputTokens` when both are present; `null` otherwise. Denormalized for cheap SUM(). */
    readonly totalTokens: number | null;
    /** Cached `length(toolCalls)` for indexable filtering. */
    readonly toolCallCount: number;
    /** Full `StepResult.toolCalls` array. Opaque to us; the SDK types it as `TypedToolCall<TOOLS>[]`. */
    readonly toolCalls: unknown;
    /** Full `StepResult.toolResults` array. Opaque to us. */
    readonly toolResults: unknown;
    /** Insert timestamp. */
    readonly createdAt: Date;
}

/**
 * Input shape for {@link StepResultBus.add}. `totalTokens` and
 * `toolCallCount` are derived at insert time and not provided here.
 */
export interface NewStepResult {
    readonly agentRunId: string;
    readonly eventId: string;
    readonly stepNumber: number;
    readonly finishReason: string;
    readonly resultText?: string | null;
    readonly reasoningText?: string | null;
    readonly inputTokens?: number | null;
    readonly outputTokens?: number | null;
    readonly toolCalls?: unknown;
    readonly toolResults?: unknown;
}
