import { EventWatcher } from "./EventWatcher";
import { TaskLoop } from "./TaskLoop";

const TEST_TOPIC = "test.hello";

/**
 * Container entry point. Runs two concurrent loops:
 *
 *   - TaskLoop: drains chat tasks from `/ipc/input/`.
 *   - EventWatcher: subscribes to the bus-state events table and prints
 *     anything that arrives on the verification topic.
 *
 * SIGTERM/SIGINT triggers a graceful drain of both. Either one resolving
 * unexpectedly is treated as a fatal exit (something went wrong in a
 * loop that should run forever).
 */
async function main(): Promise<void> {
    const postgresPassword = process.env.POSTGRES_PASSWORD;
    if (!postgresPassword) {
        throw new Error(
            "POSTGRES_PASSWORD is not set in the agent container env. " +
                "The host daemon should have passed it in via -e POSTGRES_PASSWORD=...",
        );
    }

    const taskLoop = new TaskLoop();
    const eventWatcher = new EventWatcher(TEST_TOPIC, postgresPassword);

    const shutdown = (signal: string) => {
        console.error(`Received ${signal}, draining…`);
        taskLoop.requestStop();
        eventWatcher.requestStop();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    await Promise.all([taskLoop.run(), eventWatcher.run()]);
    console.error("Agent container exiting cleanly");
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
