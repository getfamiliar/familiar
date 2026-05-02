import { TaskLoop } from "./TaskLoop";

/**
 * Container entry point. Starts the long-running task loop and wires
 * SIGTERM/SIGINT to a graceful drain (in-flight task completes, then exit).
 */
async function main(): Promise<void> {
    const loop = new TaskLoop();

    const shutdown = (signal: string) => {
        console.error(`Received ${signal}, draining…`);
        loop.requestStop();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    await loop.run();
    console.error("Agent container exiting cleanly");
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
