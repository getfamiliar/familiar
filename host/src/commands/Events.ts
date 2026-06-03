import {
    AgentRunBus,
    EventBus,
    renderMarkdown,
    StepResultBus,
    type StepResultRow,
} from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";
import { HostConfigService } from "../config/ConfigService.js";
import { PostgresContainer } from "../db/PostgresContainer.js";
import { replayOne } from "../events/ReplayEvent.js";
import { renderEventReport } from "../reports/Renderers.js";
import { parseEventIdSpec } from "./EventIdSpec.js";
import { verbosityFrom } from "./tools/verbosity.js";

/**
 * `cli.sh events emit <topic> [prompt] [--payload JSON] [--priority N]` —
 * insert one event into the bus-state DB and print the persisted row as
 * JSON. Replaces the old `event` top-level command; `prompt` is now the
 * common positional and `payload` the rarely-needed flag.
 */
const eventsEmitCommand = defineCommand({
    meta: {
        name: "emit",
        description: "Inject an event into the bus-state DB.",
    },
    args: {
        topic: {
            type: "positional",
            required: true,
            description: "Event topic (e.g. test.hello).",
        },
        prompt: {
            type: "positional",
            required: false,
            description:
                "Human-readable description of what happened; consumed as the agent's user message. Defaults to a generic line mentioning the topic.",
        },
        payload: {
            type: "string",
            description:
                'Payload as JSON; if not parseable, wrapped as { "message": "<raw>" }. Defaults to an empty object.',
        },
        priority: {
            type: "string",
            description: "Priority (higher = processed first; default 50).",
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
 * `cli.sh events report <id>` — render the full markdown report for one
 * event by reading the bus tables directly: the event header, the root
 * agentrun's step protocol with every subagent nested inline, and the
 * final result. Works on a finished or in-flight event.
 *
 * Verbosity climbs with each `-v` in the argv (same convention as
 * `tools list`): `-v` adds per-step token tables and resolved system
 * prompts; `-vv` also adds full tool-call I/O and the initial message
 * history. `--raw` skips the `marked-terminal` styling and writes the
 * underlying markdown to stdout, useful for piping into a file or a
 * markdown viewer.
 */
const eventsReportCommand = defineCommand({
    meta: {
        name: "report",
        description: "Render the full report for one event id (reads bus tables directly).",
    },
    args: {
        id: {
            type: "positional",
            required: true,
            description: "Event id (the bigserial PK in events).",
        },
        verbose: {
            type: "boolean",
            alias: "v",
            description:
                "Add detail. -v: per-step token tables + resolved system prompts (needs core.logSystemPrompt). -vv: also full tool-call I/O and the initial message history (needs inference.captureInitialMessageHistory).",
            default: false,
        },
        raw: {
            type: "boolean",
            description:
                "Skip terminal styling and emit the raw markdown verbatim. Useful for piping into a file or a markdown viewer.",
            default: false,
        },
    },
    async run({ args, rawArgs }) {
        const boot = bootstrap();
        const config = new HostConfigService(boot.configFile);
        const password = config.getString("core.postgresPassword");

        const postgres = new PostgresContainer({
            dataPath: boot.dataDir,
            portFilePath: boot.postgresPortFile,
            password,
        });
        const connection = postgres.getConnection();

        try {
            const events = new EventBus(connection);
            const agentruns = new AgentRunBus(connection);
            const steps = new StepResultBus(connection);

            const event = await events.getById(args.id);
            if (!event) {
                process.stderr.write(`Event ${args.id} not found.\n`);
                process.exit(1);
            }

            // All runs in the event's tree, plus each run's steps keyed
            // by agentrun id — the renderer is DB-free and rebuilds the
            // tree from these. The CLI shows full prose (truncate: false);
            // verbosity climbs with each `-v` in the verbatim argv, the
            // same convention as `tools list`.
            const runs = await agentruns.listByEventId(event.id);
            const stepsByRun = new Map<string, readonly StepResultRow[]>();
            for (const run of runs) {
                stepsByRun.set(run.id, await steps.listByAgentRunId(run.id));
            }

            const markdown = renderEventReport(event, runs, stepsByRun, {
                verbosity: verbosityFrom(rawArgs),
                truncate: false,
            });
            process.stdout.write(args.raw === true ? markdown : renderMarkdown(markdown));
        } finally {
            await connection.close();
        }
    },
});

/**
 * `cli.sh events replay <id-spec>` — re-emit one or more existing events
 * as fresh events. The id-spec is a comma-separated list of event ids
 * and/or inclusive spans:
 *
 *     events replay 4711
 *     events replay 123-256
 *     events replay 123-256, 555, 560-570
 *
 * Each replayed event copies the original's topic, prompt, payload,
 * priority, and routing flags into a new `events` row. Any
 * `idempotency_key` on the original gets a `-replay` suffix appended so
 * the new event isn't rejected by the original's dedup window (chains
 * of replays accumulate `-replay-replay…`).
 *
 * Scratch files at `<scratchDir>/<sourceId>/` are copied into
 * `<scratchDir>/<newId>/` inside the same INSERT transaction, mirroring
 * the emit-time staging path so the input-event watcher never observes
 * a row without its files on disk. The source dir is left untouched
 * (the original event keeps its scratch state). When the source dir is
 * absent — common, since `ScratchGc` sweeps anything older than 24 h —
 * nothing is copied and the replay still runs.
 *
 * Original ids that don't exist are reported on stderr and skipped; the
 * rest of the batch still runs. The command prints one line per emitted
 * event with the source id, the new id, and the file count.
 */
const eventsReplayCommand = defineCommand({
    meta: {
        name: "replay",
        description: "Re-emit one or more existing events as fresh events.",
    },
    args: {
        ids: {
            type: "positional",
            required: true,
            description:
                'Event id, span, or comma-separated mix (e.g. "4711", "123-256", "123-256,555,560-570").',
        },
    },
    async run({ args }) {
        const targetIds = parseEventIdSpec(args.ids);

        const boot = bootstrap();
        const config = new HostConfigService(boot.configFile);
        const password = config.getString("core.postgresPassword");

        const postgres = new PostgresContainer({
            dataPath: boot.dataDir,
            portFilePath: boot.postgresPortFile,
            password,
        });
        const connection = postgres.getConnection();

        try {
            const bus = new EventBus(connection);
            for (const sourceId of targetIds) {
                const source = await bus.getById(sourceId);
                if (!source) {
                    process.stderr.write(`Event ${sourceId} not found, skipping.\n`);
                    continue;
                }
                const { row, fileCount } = await replayOne(bus, source, boot.scratchDir);
                process.stdout.write(
                    `Replayed event ${sourceId} → ${row.id} (${fileCount} scratch file(s))\n`,
                );
            }
        } finally {
            await connection.close();
        }
    },
});

const PROMPT_PREVIEW_CHARS = 100;

/**
 * Render one cell of the prompt column: collapse newlines/tabs to single
 * spaces so the row stays on one line, then truncate to
 * {@link PROMPT_PREVIEW_CHARS} and append `…` when the original was longer.
 *
 * @param prompt The full prompt text from the event row.
 * @returns A single-line, length-bounded preview string.
 */
function renderPromptPreview(prompt: string): string {
    const flat = prompt.replace(/\s+/g, " ").trim();
    if (flat.length <= PROMPT_PREVIEW_CHARS) {
        return flat;
    }
    return `${flat.slice(0, PROMPT_PREVIEW_CHARS)}…`;
}

/**
 * Write a left-aligned, space-padded table to stdout. Column widths are
 * derived from the longest cell (or header) per column. Mirrors the
 * formatting used by `cron list` so operators see a consistent table
 * style across the CLI.
 *
 * @param headers Column header labels.
 * @param rows One string tuple per row; each row must have `headers.length` cells.
 */
function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    const fmt = (row: readonly string[]) =>
        row
            .map((cell, i) => cell.padEnd(widths[i]))
            .join("  ")
            .trimEnd();
    process.stdout.write(`${fmt(headers)}\n`);
    for (const row of rows) {
        process.stdout.write(`${fmt(row)}\n`);
    }
}

/**
 * `cli.sh events list [search] [-n N]` — print a table of the last N events
 * (default 10), newest first. Columns: ID, TOPIC, HANDLER, STATE,
 * PROMPT (first ~100 chars). When `search` is given, only rows whose
 * topic, start_handler, prompt, or payload case-insensitively contain
 * the substring are listed. Intended as the entry point to find an
 * event id to drill into with `events report <id>`.
 */
const eventsListCommand = defineCommand({
    meta: {
        name: "list",
        description: "List the most recent N events (default 10) as a table.",
    },
    args: {
        search: {
            type: "positional",
            required: false,
            description:
                "Optional case-insensitive substring matched against topic, handler, prompt, and payload.",
        },
        n: {
            type: "string",
            alias: "n",
            description: "Maximum number of events to list (default 10).",
            default: "10",
        },
    },
    async run({ args }) {
        const limit = Number.parseInt(args.n, 10);
        if (!Number.isFinite(limit) || limit <= 0) {
            process.stderr.write(`Invalid -n value: ${args.n} (expected positive integer).\n`);
            process.exit(1);
        }

        const boot = bootstrap();
        const config = new HostConfigService(boot.configFile);
        const password = config.getString("core.postgresPassword");

        const postgres = new PostgresContainer({
            dataPath: boot.dataDir,
            portFilePath: boot.postgresPortFile,
            password,
        });
        const connection = postgres.getConnection();

        try {
            const events = new EventBus(connection);
            const rows =
                args.search !== undefined && args.search !== ""
                    ? await events.searchLatest(limit, args.search)
                    : await events.listLatest(limit);

            if (rows.length === 0) {
                process.stdout.write("No events found.\n");
                return;
            }

            const tableRows = rows.map((row) => [
                row.id,
                row.topic,
                row.startHandler ?? "index",
                row.state,
                renderPromptPreview(row.prompt),
            ]);
            printTable(["ID", "TOPIC", "HANDLER", "STATE", "PROMPT"], tableRows);
        } finally {
            await connection.close();
        }
    },
});

/** Parent command for the `events` subtree (emit, list, replay, report). */
export const eventsCommand = defineCommand({
    meta: {
        name: "events",
        description: "List, inspect and work with events.",
    },
    subCommands: {
        emit: eventsEmitCommand,
        list: eventsListCommand,
        replay: eventsReplayCommand,
        report: eventsReportCommand,
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
 * Parse the optional `--payload` arg. JSON if parseable, otherwise wrap the
 * raw string as `{ message: <raw> }` so casual one-liners work. Returns an
 * empty object when no payload was provided.
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
