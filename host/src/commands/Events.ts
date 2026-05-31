import { AgentRunBus, EventBus, renderMarkdown, StepResultBus } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import ora from "ora";
import { bootstrap } from "../Bootstrap.js";
import { HostConfigService } from "../config/ConfigService.js";
import { PostgresContainer } from "../db/PostgresContainer.js";
import { replayOne } from "../events/ReplayEvent.js";
import {
    type AgentrunAggregate,
    aggregateSteps,
    renderAgentrunResult,
    renderAgentrunStart,
    renderEventCreated,
    renderEventResult,
    renderStepResult,
} from "../reports/Renderers.js";
import { ReportPoller } from "../reports/ReportPoller.js";
import { ReportTerminalPrinter } from "../reports/ReportTerminalPrinter.js";
import { parseEventIdSpec } from "./EventIdSpec.js";

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
 * `cli.sh events tail` — stays attached and prints rendered markdown for
 * every new or state-changed event / agentrun / step the daemon produces
 * from now onward. Backed by `ReportPoller`, which queries the bus tables
 * once a second; no NOTIFY subscription is required.
 *
 * Output is styled with `marked-terminal` so headings, tables, and code
 * blocks render with ANSI colour. A header line announces the start, and
 * an `ora` spinner stays pinned to the bottom of the terminal between
 * activity bursts so the operator can see the poller is alive. Ctrl-C
 * aborts cleanly.
 */
const eventsTailCommand = defineCommand({
    meta: {
        name: "tail",
        description: "Follow the event bus and pretty-print new activity as it happens.",
    },
    args: {
        details: {
            type: "boolean",
            alias: "d",
            description:
                "Include verbose details (e.g. resolved system prompt) in the agentrun-start section. Requires core.logSystemPrompt for the system prompt to actually be available.",
            default: false,
        },
    },
    async run({ args }) {
        const boot = bootstrap();
        const config = new HostConfigService(boot.configFile);
        const password = config.getString("core.postgresPassword");

        const postgres = new PostgresContainer({
            dataPath: boot.dataDir,
            portFilePath: boot.postgresPortFile,
            password,
        });
        const connection = postgres.getConnection();

        const controller = new AbortController();
        const onSignal = () => controller.abort();
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);

        process.stdout.write("Starting to list event processing results...\n");

        const spinner = ora({
            text: "Waiting for something to happen...",
            isEnabled: process.stdout.isTTY,
        }).start();

        const printer = new ReportTerminalPrinter(connection, {
            withDetails: Boolean(args.details),
            onWriteBoundary: {
                before: () => spinner.stop(),
                after: () => spinner.start(),
            },
        });
        const poller = new ReportPoller({
            connection,
            sink: printer,
            startAnchor: new Date(),
        });

        try {
            await poller.start(controller.signal);
        } finally {
            spinner.stop();
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            await connection.close();
        }
    },
});

/**
 * `cli.sh events report <id>` — render the full markdown report for one
 * event by reading the bus tables directly. Includes every section
 * `events tail` would have streamed (event created, every agentrun
 * start + steps + result, final event summary) so an operator can
 * review a finished — or in-flight — event without scrolling through
 * `events tail`'s history.
 *
 * `--raw` skips the `marked-terminal` styling and writes the
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
        raw: {
            type: "boolean",
            description:
                "Skip terminal styling and emit the raw markdown verbatim. Useful for piping into a file or a markdown viewer.",
            default: false,
        },
    },
    async run({ args }) {
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

            const runs = await agentruns.listByEventId(event.id);

            const sections: string[] = [];
            sections.push(renderEventCreated(event));
            // `withDetails: true` so the system prompt is included
            // when it was logged. The renderer's own guard means
            // the section is silently omitted when system_prompt is
            // null (i.e. core.logSystemPrompt was off at the time).
            for (const run of runs) {
                sections.push(renderAgentrunStart(run, { withDetails: true }));
                const runSteps = await steps.listByAgentRunId(run.id);
                for (const step of runSteps) {
                    sections.push(renderStepResult(run, step));
                }
                if (run.state === "done" || run.state === "failed") {
                    const aggregate: AgentrunAggregate = {
                        ...aggregateSteps(runSteps),
                        runtimeMs: Math.max(0, run.updatedAt.getTime() - run.createdAt.getTime()),
                    };
                    sections.push(renderAgentrunResult(run, aggregate));
                }
            }
            if (event.state === "done" || event.state === "failed") {
                sections.push(renderEventResult(event, runs));
            }

            const markdown = sections.join("");
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

/** Parent command for the `events` subtree (emit, list, replay, report, tail). */
export const eventsCommand = defineCommand({
    meta: {
        name: "events",
        description: "Inject and inspect events on the bus (emit, list, replay, report, tail).",
    },
    subCommands: {
        emit: eventsEmitCommand,
        list: eventsListCommand,
        replay: eventsReplayCommand,
        report: eventsReportCommand,
        tail: eventsTailCommand,
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
