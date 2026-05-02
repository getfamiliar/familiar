import { EventWatcher } from "./EventWatcher";

const TEST_TOPIC = "test.hello";

/**
 * Container entry point. Runs the bus-state event watcher, which is
 * the only host↔container communication channel. SIGTERM/SIGINT
 * triggers a graceful drain.
 */
async function main(): Promise<void> {
    const postgresPassword = process.env.POSTGRES_PASSWORD;
    if (!postgresPassword) {
        throw new Error(
            "POSTGRES_PASSWORD is not set in the agent container env. " +
                "The host daemon should have passed it in via -e POSTGRES_PASSWORD=...",
        );
    }

    const eventWatcher = new EventWatcher(TEST_TOPIC, postgresPassword);

    const shutdown = (signal: string) => {
        console.error(`Received ${signal}, draining…`);
        eventWatcher.requestStop();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    await eventWatcher.run();
    console.error("Agent container exiting cleanly");
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
