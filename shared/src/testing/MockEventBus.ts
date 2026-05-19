import type { EventPatch, EventRow, EventState, NewEvent } from "../Event.js";
import type { MockBusStore } from "./MockBusStore.js";

/**
 * In-memory {@link EventBus} replacement for unit tests. The Scheduler
 * tests need only a tiny slice of the surface — `getById`, occasional
 * `update`, and an `add` helper to seed events. Anything beyond that
 * is not needed yet and intentionally absent.
 *
 * Stored in a shared {@link MockBusStore} so `MockAgentRunBus.settle`
 * can recompute the parent event's terminal state on the same data.
 */
export class MockEventBus {
    constructor(private readonly store: MockBusStore) {}

    /** No-op — kept for shape compatibility with the production bus. */
    async installSchema(): Promise<void> {
        // intentionally empty
    }

    async add(event: NewEvent): Promise<EventRow> {
        const id = String(this.store.nextEventId++);
        const now = new Date();
        const row: EventRow = {
            id,
            topic: event.topic,
            priority: event.priority ?? 50,
            state: "pending",
            payload: event.payload ?? {},
            idempotencyKey: event.idempotencyKey ?? null,
            isChat: event.isChat === true,
            preferredChatChannelId: event.preferredChatChannelId ?? null,
            prompt: event.prompt ?? null,
            startHandler: event.startHandler ?? null,
            privileged: event.privileged === true,
            createdAt: now,
            updatedAt: now,
        };
        this.store.events.set(id, row);
        return row;
    }

    async getById(id: string): Promise<EventRow | undefined> {
        return this.store.events.get(id);
    }

    async update(id: string, patch: EventPatch): Promise<void> {
        const row = this.store.events.get(id);
        if (!row) {
            throw new Error(`Event ${id} not found`);
        }
        const next: EventRow = {
            ...row,
            state: (patch.state as EventState) ?? row.state,
            payload: patch.payload === undefined ? row.payload : patch.payload,
            updatedAt: new Date(),
        };
        this.store.events.set(id, next);
    }
}
