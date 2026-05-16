import { defineCommand } from "citty";
import { EventBus } from "@getfamiliar/shared";
import { bootstrap } from "../Bootstrap.js";
import { HostConfigService } from "../config/ConfigService.js";
import { PostgresContainer } from "../db/PostgresContainer.js";

/**
 * `cli.sh event <topic> [payload] [--priority N]` — insert one event into
 * the bus-state DB and print the persisted row as JSON.
 *
 * Reuses `PostgresContainer` purely as a config provider — it doesn't
 * manage the running container's lifecycle from here, just reads the
 * persisted port and uses the password from `.env`.
 */
export const eventCommand = defineCommand({
    meta: {
        name: "event",
        description: "Inject an event into the bus-state DB.",
    },
    args: {
        topic: {
            type: "positional",
            required: true,
            description: "Event topic (e.g. test.hello).",
        },
        payload: {
            type: "positional",
            required: false,
            description: 'Payload as JSON; if not parseable, wrapped as { "message": "<raw>" }.',
        },
        priority: {
            type: "string",
            description: "Priority (higher = processed first; default 50).",
        },
        prompt: {
            type: "string",
            description:
                "Human-readable description of what happened; consumed as the agent's user message. Defaults to a generic line mentioning the topic.",
        },
    },
    async run({ args }) {
        const boot = bootstrap();
        const config = new HostConfigService(boot.configFile);
        const password = config.getString("core.postgresPassword");

        const priority = parsePriority(args.priority);
        const payload = parsePayload(args.payload);
        const prompt = args.prompt ?? `Manually injected event of topic \`${args.topic}\`.`;

        const postgres = new PostgresContainer({
            dataPath: boot.dataDir,
            portFilePath: boot.postgresPortFile,
            password,
        });
        const connection = postgres.getConnection();
        const bus = new EventBus(connection);

        try {
            const row = await bus.add({
                topic: args.topic,
                payload,
                priority,
                prompt,
            });
            process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
        } finally {
            await connection.close();
        }
    },
});

/**
 * Parse the optional `--priority` arg. Returns undefined when absent.
 *
 * @throws If the value is not an integer.
 */
function parsePriority(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid --priority: ${raw}`);
    }
    return parsed;
}

/**
 * Parse the optional payload arg. JSON if parseable, otherwise wrap the
 * raw string as `{ message: <raw> }` so casual one-liners work.
 */
function parsePayload(raw: string | undefined): unknown {
    if (raw === undefined) {
        return {};
    }
    try {
        return JSON.parse(raw);
    } catch {
        return { message: raw };
    }
}
