import type { Logger } from "./logging/Logger";
import type { NotificationHandler, PostgresConnection } from "./PostgresConnection";
import { STEPRESULTS_NEW_CHANNEL } from "./Schema";
import type { NewStepResult, StepResultRow } from "./StepResult";

/** Raw row shape returned by the SELECT. `pg` returns bigints as strings. */
interface RawStepResultRow {
    id: string;
    agent_run_id: string;
    event_id: string;
    step_number: number;
    finish_reason: string;
    result_text: string | null;
    reasoning_text: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    tool_call_count: number;
    tool_calls: unknown;
    tool_results: unknown;
    created_at: Date;
}

/**
 * Disposer returned by {@link StepResultBus.listen}. Calling it
 * unsubscribes the handler from the underlying NOTIFY channel.
 * Idempotent: calling more than once is safe.
 */
export type StepResultUnsubscribe = () => Promise<void>;

/**
 * Domain client for the `stepresults` audit table.
 *
 * INSERT-only — steps are immutable, with no claim / update semantics.
 * The container's {@link import("./AgentRunBus").AgentRunBus} runner
 * `add`s a row from inside `ToolLoopAgent.generate`'s `onStepFinish`;
 * the host's `HostContextImpl` `listen`s for them inside `events.emit`
 * to surface live step events to plugins.
 */
export class StepResultBus {
    private readonly connection: PostgresConnection;
    private readonly log: Logger | undefined;

    constructor(connection: PostgresConnection, log?: Logger) {
        this.connection = connection;
        this.log = log;
    }

    /**
     * Insert a step row and return the persisted shape. The derived
     * columns `total_tokens` (sum of input+output when both present)
     * and `tool_call_count` (length of toolCalls array) are filled
     * here so callers don't have to.
     */
    async add(step: NewStepResult): Promise<StepResultRow> {
        const inputTokens = step.inputTokens ?? null;
        const outputTokens = step.outputTokens ?? null;
        const totalTokens =
            inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
        const toolCalls = step.toolCalls ?? [];
        const toolResults = step.toolResults ?? [];
        const toolCallCount = Array.isArray(toolCalls) ? toolCalls.length : 0;

        const result = await this.connection.getPool().query<RawStepResultRow>(
            `INSERT INTO stepresults
                (agent_run_id, event_id, step_number, finish_reason,
                 result_text, reasoning_text,
                 input_tokens, output_tokens, total_tokens,
                 tool_call_count, tool_calls, tool_results)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
             RETURNING *`,
            [
                step.agentRunId,
                step.eventId,
                step.stepNumber,
                step.finishReason,
                step.resultText ?? null,
                step.reasoningText ?? null,
                inputTokens,
                outputTokens,
                totalTokens,
                toolCallCount,
                JSON.stringify(toolCalls),
                JSON.stringify(toolResults),
            ],
        );
        return mapRow(result.rows[0]);
    }

    /**
     * Subscribe to {@link STEPRESULTS_NEW_CHANNEL}. The notification
     * payload (`<event_id>:<agent_run_id>:<id>`) is parsed, the row
     * is fetched by id, and `handler` is invoked with it.
     *
     * Errors thrown by `handler` are caught and logged so one bad
     * subscriber doesn't break others on the same channel.
     *
     * Returns a disposer; call it to unlisten. Idempotent.
     */
    async listen(
        handler: (row: StepResultRow) => void | Promise<void>,
    ): Promise<StepResultUnsubscribe> {
        const wrapper: NotificationHandler = (payload) => {
            this.log?.debug(
                { channel: STEPRESULTS_NEW_CHANNEL, payload },
                "NOTIFY stepresults_new",
            );
            void this.dispatchNotification(payload, handler);
        };
        await this.connection.listen(STEPRESULTS_NEW_CHANNEL, wrapper);

        let disposed = false;
        return async () => {
            if (disposed) {
                return;
            }
            disposed = true;
            await this.connection.unlisten(STEPRESULTS_NEW_CHANNEL, wrapper);
        };
    }

    /**
     * Fetch a step by id. Useful when a notification handler has the
     * id from the channel payload but wants the full typed row.
     */
    async getById(id: string): Promise<StepResultRow | undefined> {
        const result = await this.connection
            .getPool()
            .query<RawStepResultRow>(`SELECT * FROM stepresults WHERE id = $1`, [id]);
        return result.rows.length > 0 ? mapRow(result.rows[0]) : undefined;
    }

    /**
     * Inner notification dispatcher. Parses the channel payload,
     * fetches the row, and invokes the handler — catching and
     * logging any error from the handler itself.
     */
    private async dispatchNotification(
        payload: string,
        handler: (row: StepResultRow) => void | Promise<void>,
    ): Promise<void> {
        const parts = payload.split(":");
        if (parts.length !== 3) {
            return;
        }
        const [, , id] = parts;
        try {
            const row = await this.getById(id);
            if (!row) {
                return;
            }
            await handler(row);
        } catch (err) {
            console.error(
                `StepResultBus listen handler error for id=${id}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}

/** Convert a snake_case raw row into the camelCase {@link StepResultRow}. */
function mapRow(raw: RawStepResultRow): StepResultRow {
    return {
        id: raw.id,
        agentRunId: raw.agent_run_id,
        eventId: raw.event_id,
        stepNumber: raw.step_number,
        finishReason: raw.finish_reason,
        resultText: raw.result_text,
        reasoningText: raw.reasoning_text,
        inputTokens: raw.input_tokens,
        outputTokens: raw.output_tokens,
        totalTokens: raw.total_tokens,
        toolCallCount: raw.tool_call_count,
        toolCalls: raw.tool_calls,
        toolResults: raw.tool_results,
        createdAt: raw.created_at,
    };
}
