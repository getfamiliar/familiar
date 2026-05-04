import {
    POSTGRES_DB,
    POSTGRES_HOST,
    POSTGRES_PORT,
    POSTGRES_USER,
    PostgresConnection,
} from "effective-assistant-shared";
import { AgentrunWatcher } from "./AgentrunWatcher";
import { EventWatcher } from "./EventWatcher";
import { HandlerFile } from "./HandlerFile";

/**
 * Process-wide handler-header defaults. A handler can override any of
 * these in its YAML frontmatter; values left undeclared fall through
 * to these defaults.
 */
const HEADER_DEFAULTS = {
    /** Bound the size of any single model step. See HandlerFileHeader. */
    maxOutputTokens: 1000,
};

/**
 * Container entry point. Owns the postgres connection, spawns the
 * input-event watcher and the agentrun watcher off it, runs them
 * concurrently, and closes the connection on exit.
 *
 * SIGTERM/SIGINT abort both watchers; their loops exit cleanly and the
 * top-level `Promise.all` resolves.
 */
async function main(): Promise<void> {
    const postgresPassword = process.env.POSTGRES_PASSWORD;
    if (!postgresPassword) {
        throw new Error(
            "POSTGRES_PASSWORD is not set in the agent container env. " +
                "The host daemon should have passed it in via -e POSTGRES_PASSWORD=...",
        );
    }

    HandlerFile.setHeaderDefaults(HEADER_DEFAULTS);

    const connection = new PostgresConnection({
        host: POSTGRES_HOST,
        port: POSTGRES_PORT,
        user: POSTGRES_USER,
        password: postgresPassword,
        database: POSTGRES_DB,
    });

    const eventWatcher = new EventWatcher(connection);
    const agentWatcher = new AgentrunWatcher(connection);

    const abortController = new AbortController();
    const shutdown = (signal: string) => {
        console.error(`Received ${signal}, draining…`);
        abortController.abort();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    try {
        await Promise.all([
            eventWatcher.run(abortController.signal),
            agentWatcher.run(abortController.signal),
        ]);
    } finally {
        await connection.close();
        console.error("Agent container exiting cleanly");
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
