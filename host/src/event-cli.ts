import { resolve } from "node:path";
import { EventBus } from "effective-assistant-shared";
import { PostgresContainer } from "./db/PostgresContainer";

const DATA_DIR = resolve(__dirname, "../../data");
const POSTGRES_PORT_FILE = `${DATA_DIR}/.postgres-port`;

interface ParsedArgs {
    readonly topic: string;
    readonly payload: unknown;
    readonly priority: number | undefined;
}

/**
 * Parse argv for the event CLI. Form:
 *
 *   event <topic> [payload-json] [--priority N]
 *
 * If `payload-json` is omitted, payload defaults to `{}`. If it's not
 * valid JSON, it's wrapped as `{ "message": "<raw string>" }` so a
 * casual `./cli.sh event test.hello "hi there"` still works.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
    const positional: string[] = [];
    let priority: number | undefined;

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--priority" || arg === "-p") {
            const value = argv[i + 1];
            if (!value) {
                throw new Error("--priority requires a value");
            }
            priority = Number.parseInt(value, 10);
            if (!Number.isFinite(priority)) {
                throw new Error(`Invalid --priority: ${value}`);
            }
            i += 1;
        } else if (arg === "--help" || arg === "-h") {
            process.stdout.write(
                "Usage: cli.sh event <topic> [payload-json] [--priority N]\n",
            );
            process.exit(0);
        } else {
            positional.push(arg);
        }
    }

    const [topic, payloadRaw] = positional;
    if (!topic) {
        throw new Error("topic is required");
    }

    let payload: unknown = {};
    if (payloadRaw !== undefined) {
        try {
            payload = JSON.parse(payloadRaw);
        } catch {
            payload = { message: payloadRaw };
        }
    }

    return { topic, payload, priority };
}

/**
 * CLI entry point: insert one event into the bus and print its row as JSON.
 * Reuses {@link PostgresContainer} purely as a config provider — it
 * doesn't manage the running container's lifecycle from here, just reads
 * the persisted port and the password from `.env`.
 */
async function main(): Promise<void> {
    const password = process.env.POSTGRES_PASSWORD;
    if (!password) {
        throw new Error(
            "POSTGRES_PASSWORD is not set. Add it to .env at the repo root.",
        );
    }

    const args = parseArgs(process.argv.slice(2));

    const postgres = new PostgresContainer({
        dataPath: DATA_DIR,
        portFilePath: POSTGRES_PORT_FILE,
        password,
    });
    const connection = postgres.getConnection();
    const bus = new EventBus(connection);

    try {
        const row = await bus.add({
            topic: args.topic,
            payload: args.payload,
            priority: args.priority,
        });
        process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
    } finally {
        await connection.close();
    }
}

main().catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
