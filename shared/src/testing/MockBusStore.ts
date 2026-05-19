import type { AgentRunRow } from "../AgentRun.js";
import type { EventRow } from "../Event.js";

/**
 * Shared in-memory backing store for {@link MockAgentRunBus} and
 * {@link MockEventBus}. Lets `settle()` on the agentrun bus recompute
 * the parent event's terminal state — the cross-table coupling the
 * production schema enforces via {@link EVENT_TERMINAL_UPDATE_SQL} —
 * without separate processes or a real postgres.
 *
 * Construct one store per test and pass it into both bus mocks.
 * `nextEventId` / `nextAgentrunId` mirror postgres's `bigserial`,
 * yielding deterministic ids `"1"`, `"2"`, … in the order rows are
 * inserted.
 */
export class MockBusStore {
    readonly events = new Map<string, EventRow>();
    readonly agentruns = new Map<string, AgentRunRow>();
    nextEventId = 1;
    nextAgentrunId = 1;

    /** All agentruns whose parent_agentrun_id matches `parentId`. */
    childrenOf(parentId: string): AgentRunRow[] {
        return [...this.agentruns.values()].filter((r) => r.parentAgentrunId === parentId);
    }
}
