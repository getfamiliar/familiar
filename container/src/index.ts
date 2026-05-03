import {
    POSTGRES_DB,
    POSTGRES_HOST,
    POSTGRES_PORT,
    POSTGRES_USER,
    PostgresConnection,
} from "effective-assistant-shared";
import { TriageWatcher } from "./TriageWatcher";

/**
 * Container entry point. Owns the postgres connection, spawns the
 * input-event watcher (placeholder), runs it, and closes the
 * connection on exit.
 *
 * SIGTERM/SIGINT abort the watcher; its loop exits cleanly and the
 * top-level `Promise.all` resolves. The agentrun watcher and the real
 * input-event behavior land in the next plan.
 */
async function main(): Promise<void> {
    const postgresPassword = process.env.POSTGRES_PASSWORD;
    if (!postgresPassword) {
        throw new Error(
            "POSTGRES_PASSWORD is not set in the agent container env. " +
                "The host daemon should have passed it in via -e POSTGRES_PASSWORD=...",
        );
    }

    const connection = new PostgresConnection({
        host: POSTGRES_HOST,
        port: POSTGRES_PORT,
        user: POSTGRES_USER,
        password: postgresPassword,
        database: POSTGRES_DB,
    });

    const triage = new TriageWatcher(connection);

    const abortController = new AbortController();
    const shutdown = (signal: string) => {
        console.error(`Received ${signal}, draining…`);
        abortController.abort();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    try {
        await Promise.all([triage.run(abortController.signal)]);
    } finally {
        await connection.close();
        console.error("Agent container exiting cleanly");
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
