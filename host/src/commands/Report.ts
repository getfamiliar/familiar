import { defineCommand } from "citty";
import { AgentRunBus, EventBus, StepResultBus } from "effective-assistant-shared";
import { bootstrap } from "../Bootstrap.js";
import { HostConfigService } from "../config/ConfigService.js";
import { PostgresContainer } from "../db/PostgresContainer.js";
import { md } from "../reports/markedTerminal.js";
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

/**
 * `ea report tail` — stays attached and prints rendered markdown for
 * every new or state-changed event / agentrun / step the daemon
 * produces from now onward. Backed by `ReportPoller`, which queries
 * the bus tables once a second; no NOTIFY subscription is required.
 *
 * Output is styled with `marked-terminal` so headings, tables, and
 * code blocks render with ANSI colour. Ctrl-C aborts cleanly.
 */
const reportTailCommand = defineCommand({
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

        const printer = new ReportTerminalPrinter(connection, {
            withDetails: Boolean(args.details),
        });
        const poller = new ReportPoller({
            connection,
            sink: printer,
            startAnchor: new Date(),
        });

        try {
            await poller.start(controller.signal);
        } finally {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            await connection.close();
        }
    },
});

/**
 * `ea report event <id>` — render the full markdown report for one
 * event by reading the bus tables directly. Includes every section
 * `report tail` would have streamed (event created, every agentrun
 * start + steps + result, final event summary) so an operator can
 * review a finished — or in-flight — event without scrolling
 * through `report tail`'s history.
 *
 * `--raw` skips the `marked-terminal` styling and writes the
 * underlying markdown to stdout, useful for piping into a file or
 * a markdown viewer.
 */
const reportEventCommand = defineCommand({
    meta: {
        name: "event",
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
            process.stdout.write(args.raw === true ? markdown : md(markdown));
        } finally {
            await connection.close();
        }
    },
});

/** Parent command for the `report` subtree. */
export const reportCommand = defineCommand({
    meta: {
        name: "report",
        description: "Markdown reports for the event bus (tail, per-event view).",
    },
    subCommands: {
        tail: reportTailCommand,
        event: reportEventCommand,
    },
});
