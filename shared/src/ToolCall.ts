/** Persisted shape of a `tool_calls` row. */
export interface ToolCallRow {
    readonly id: string;
    readonly agentRunId: string | null;
    readonly handlerPath: string;
    readonly toolName: string;
    readonly successful: boolean;
    readonly createdAt: Date;
}

/** Insert shape — `id` and `createdAt` are filled by the DB. */
export interface NewToolCall {
    readonly agentRunId?: string | null;
    readonly handlerPath: string;
    readonly toolName: string;
    readonly successful: boolean;
}

/**
 * One tool's usage count over a window of runs — the shape the
 * heuristic tool-preloader consumes. Ordered most-used first by the
 * query that produces it.
 */
export interface ToolUsageCount {
    readonly toolName: string;
    readonly count: number;
}
