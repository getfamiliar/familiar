import type { AgentRunCallType, AgentRunPatch, AgentRunRow, NewAgentRun } from "../AgentRun.js";
import type { MockBusStore } from "./MockBusStore.js";

/**
 * Listener for {@link MockAgentRunBus.subscribe}. Fires synchronously
 * after every state-affecting write so test code can advance the
 * Scheduler in lock-step with mutations.
 */
export type MockAgentRunBusListener = (row: AgentRunRow) => void;

/**
 * In-memory {@link AgentRunBus} replacement for unit tests. Stores
 * agentruns in a {@link MockBusStore} so it can recompute the parent
 * event's terminal state when a row settles — the same coupling the
 * production schema's `EVENT_TERMINAL_UPDATE_SQL` enforces.
 *
 * Listeners (subscribed via {@link subscribe}) fire synchronously
 * after every state-affecting write, replacing postgres NOTIFY for
 * test purposes.
 *
 * The class is intentionally not typed as `implements AgentRunBus`:
 * the production class carries private postgres fields that block
 * structural compat. The Scheduler (and any other consumer wanting
 * test-friendliness) should accept a structural subset of the bus —
 * e.g. `Pick<AgentRunBus, 'add' | 'update' | …>` — which this class
 * satisfies by shape.
 */
export class MockAgentRunBus {
    private readonly listeners: MockAgentRunBusListener[] = [];

    constructor(private readonly store: MockBusStore) {}

    /** No-op — kept for shape compatibility with the production bus. */
    async installSchema(): Promise<void> {
        // intentionally empty
    }

    async add(run: NewAgentRun): Promise<AgentRunRow> {
        const id = String(this.store.nextAgentrunId++);
        const now = new Date();
        const row: AgentRunRow = {
            id,
            eventId: run.eventId,
            parentAgentrunId: run.parentAgentrunId ?? null,
            topic: run.topic,
            handler: run.handler,
            priority: run.priority ?? 50,
            state: run.state ?? "pending",
            prompt: run.prompt ?? null,
            payload: run.payload ?? {},
            result: null,
            resultText: null,
            error: null,
            privileged: run.privileged ?? false,
            calltype: (run.calltype ?? null) as AgentRunCallType | null,
            retryCount: 0,
            notBefore: null,
            model: null,
            systemPrompt: null,
            initialMessages: null,
            createdAt: now,
            updatedAt: now,
        };
        this.store.agentruns.set(id, row);
        this.fire(row);
        return row;
    }

    async update(id: string, patch: AgentRunPatch): Promise<void> {
        const row = this.store.agentruns.get(id);
        if (!row) {
            throw new Error(`Agentrun ${id} not found`);
        }
        const next: AgentRunRow = {
            ...row,
            state: patch.state ?? row.state,
            payload: patch.payload === undefined ? row.payload : patch.payload,
            result: patch.result === undefined ? row.result : patch.result,
            resultText: patch.resultText === undefined ? row.resultText : patch.resultText,
            error: patch.error === undefined ? row.error : patch.error,
            priority: patch.priority ?? row.priority,
            model: patch.model === undefined ? row.model : patch.model,
            systemPrompt: patch.systemPrompt === undefined ? row.systemPrompt : patch.systemPrompt,
            initialMessages:
                patch.initialMessages === undefined ? row.initialMessages : patch.initialMessages,
            calltype: patch.calltype === undefined ? row.calltype : patch.calltype,
            updatedAt: new Date(),
        };
        this.store.agentruns.set(id, next);
        this.fire(next);
    }

    async settle(
        id: string,
        toState: "done" | "failed",
        outcome: {
            readonly result?: unknown;
            readonly resultText?: string | null;
            readonly error?: string | null;
        } = {},
    ): Promise<void> {
        const row = this.store.agentruns.get(id);
        if (!row) {
            throw new Error(`Agentrun ${id} not found`);
        }
        const next: AgentRunRow = {
            ...row,
            state: toState,
            result: outcome.result === undefined ? row.result : outcome.result,
            resultText: outcome.resultText === undefined ? row.resultText : outcome.resultText,
            error: outcome.error === undefined ? row.error : outcome.error,
            updatedAt: new Date(),
        };
        this.store.agentruns.set(id, next);

        // Mirror EVENT_TERMINAL_UPDATE_SQL: the event's terminal state
        // mirrors the root agentrun's terminal state. Settling a
        // non-root agentrun is a no-op for the event.
        this.recomputeEventTerminal(row, toState);

        this.fire(next);
    }

    async getById(id: string): Promise<AgentRunRow | undefined> {
        return this.store.agentruns.get(id);
    }

    async listEligible(): Promise<readonly AgentRunRow[]> {
        const now = Date.now();
        return [...this.store.agentruns.values()]
            .filter(
                (r) =>
                    r.state === "pending" && (r.notBefore === null || r.notBefore.getTime() <= now),
            )
            .sort((a, b) => b.priority - a.priority || Number(a.id) - Number(b.id));
    }

    async areAllCalledChildrenSettled(parentId: string): Promise<boolean> {
        for (const row of this.store.agentruns.values()) {
            if (
                row.parentAgentrunId === parentId &&
                row.calltype === "called" &&
                row.state !== "done" &&
                row.state !== "failed"
            ) {
                return false;
            }
        }
        return true;
    }

    async listSince(since: Date): Promise<AgentRunRow[]> {
        return [...this.store.agentruns.values()]
            .filter((r) => r.updatedAt.getTime() >= since.getTime())
            .sort(
                (a, b) =>
                    a.updatedAt.getTime() - b.updatedAt.getTime() || Number(a.id) - Number(b.id),
            );
    }

    async listByEventId(eventId: string): Promise<readonly AgentRunRow[]> {
        return [...this.store.agentruns.values()]
            .filter((r) => r.eventId === eventId)
            .sort((a, b) => Number(a.id) - Number(b.id));
    }

    async postpone(id: string, runAfter: Date, errorText: string | null): Promise<void> {
        const row = this.store.agentruns.get(id);
        if (!row) {
            throw new Error(`Agentrun ${id} not found`);
        }
        const next: AgentRunRow = {
            ...row,
            state: "pending",
            retryCount: row.retryCount + 1,
            notBefore: runAfter,
            error: errorText,
            updatedAt: new Date(),
        };
        this.store.agentruns.set(id, next);
        this.fire(next);
    }

    /**
     * Test-only: subscribe to row-change notifications. Replaces
     * postgres NOTIFY for test code. Returns an unsubscriber.
     */
    subscribe(listener: MockAgentRunBusListener): () => void {
        this.listeners.push(listener);
        return () => {
            const idx = this.listeners.indexOf(listener);
            if (idx >= 0) {
                this.listeners.splice(idx, 1);
            }
        };
    }

    private fire(row: AgentRunRow): void {
        for (const l of this.listeners) {
            l(row);
        }
    }

    private recomputeEventTerminal(settledRow: AgentRunRow, settledState: "done" | "failed"): void {
        if (settledRow.parentAgentrunId !== null) {
            return;
        }
        const event = this.store.events.get(settledRow.eventId);
        if (!event || event.state !== "running") {
            return;
        }
        const next = { ...event, state: settledState, updatedAt: new Date() };
        this.store.events.set(settledRow.eventId, next as typeof event);
    }
}
