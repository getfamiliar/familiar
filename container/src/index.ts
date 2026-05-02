import type { EventRow } from "effective-assistant-shared";
import { EventWatcher } from "./EventWatcher";

const TEST_TOPIC = "test.hello";

/**
 * Container entry point. Loops over events from the bus on the
 * verification topic, transitioning each through the lifecycle:
 * `pending → processing → done` (or `failed` on error).
 *
 * SIGTERM/SIGINT abort the iterator; `nextEvent` then resolves to
 * `null` and the loop exits cleanly.
 */
async function main(): Promise<void> {
    const postgresPassword = process.env.POSTGRES_PASSWORD;
    if (!postgresPassword) {
        throw new Error(
            "POSTGRES_PASSWORD is not set in the agent container env. " +
                "The host daemon should have passed it in via -e POSTGRES_PASSWORD=...",
        );
    }

    const watcher = new EventWatcher(TEST_TOPIC, postgresPassword);
    const abortController = new AbortController();

    const shutdown = (signal: string) => {
        console.error(`Received ${signal}, draining…`);
        abortController.abort();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    console.error(`Event watcher subscribed to topic "${TEST_TOPIC}"`);

    try {
        let event: EventRow | null;
        while ((event = await watcher.nextEvent(abortController.signal)) !== null) {
            await processEvent(watcher, event);
        }
    } finally {
        await watcher.close();
        console.error("Agent container exiting cleanly");
    }
}

/**
 * Run the test topic's processing policy: log the event, mark it
 * `done`. Marks `failed` on any error so the row reflects the outcome.
 */
async function processEvent(watcher: EventWatcher, event: EventRow): Promise<void> {
    try {
        await watcher.markProcessing(event.id);
        console.log(
            `[event] id=${event.id} topic=${event.topic} payload=${JSON.stringify(event.payload)}`,
        );
        // Real processing would happen here.
        await watcher.markDone(event.id);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Event id=${event.id} failed: ${message}`);
        try {
            await watcher.markFailed(event.id);
        } catch (markErr) {
            console.error(
                `Also failed to mark failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
            );
        }
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
