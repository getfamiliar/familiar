import {
    AgentRunBus,
    EventBus,
    type PluginTool,
    runTextTool,
    StepResultBus,
    type StepResultRow,
    ToolError,
} from "@getfamiliar/shared";
import { renderEventReport, type VerbosityLevel } from "../../reports/Renderers.js";
import type { ReflectionToolsDeps } from "../ReflectionTools.js";

interface EventReportArgs {
    readonly id?: string;
    readonly verbosity?: number;
    readonly truncate?: boolean;
}

/**
 * Build the `event_report` reflection tool — the agent-facing
 * equivalent of `./cli.sh events report <id>`. Renders the event and
 * its full agentrun tree as one hierarchical markdown document, with
 * subagents nested inline. `verbosity` (0/1/2) climbs the same ladder as
 * the CLI's `-v`/`-vv`; `truncate` (default `true`) caps long prose /
 * JSON so the report stays bounded in the calling run's context.
 */
export function buildEventReportTool(
    deps: ReflectionToolsDeps,
): PluginTool<EventReportArgs, string> {
    return {
        name: "event_report",
        description:
            "Render a markdown report for one event: its metadata, the agentrun tree (each " +
            "subagent nested inline at the step that spawned it), and the final outcome. " +
            "`verbosity` 0 (default) shows the step protocol; 1 adds per-step token tables and " +
            "resolved system prompts; 2 also adds full tool-call I/O and the initial message " +
            "history. `truncate` (default true) caps long prose / JSON. Pass the event `id` from " +
            "`event_list`.",
        groups: ["reflection"],
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: {
                id: {
                    type: "string",
                    description: "Event id (the bigserial PK from the events table).",
                },
                verbosity: {
                    type: "integer",
                    enum: [0, 1, 2],
                    description:
                        "Detail level: 0 step protocol; 1 + token tables + system prompts; 2 + " +
                        "tool I/O + initial message history. Defaults to 0.",
                },
                truncate: {
                    type: "boolean",
                    description:
                        "Cap long prose / JSON to keep the report small. Defaults to true; set " +
                        "false to see full text when diagnosing.",
                },
            },
        },
        execute: (args, callCtx) =>
            runTextTool(async () => {
                const id = requireId(args.id, "event");

                const connection = await deps.ensureConnection();
                const events = new EventBus(connection);
                const agentruns = new AgentRunBus(connection);
                const steps = new StepResultBus(connection);

                const event = await events.getById(id);
                if (!event) {
                    throw new ToolError("EventNotFound", `Event ${id} not found.`);
                }

                const runs = await agentruns.listByEventId(event.id);
                const stepsByRun = new Map<string, readonly StepResultRow[]>();
                for (const run of runs) {
                    stepsByRun.set(run.id, await steps.listByAgentRunId(run.id));
                }

                return renderEventReport(event, runs, stepsByRun, {
                    verbosity: normalizeVerbosity(args.verbosity),
                    truncate: args.truncate ?? true,
                });
            }, callCtx.toolRunContext),
    };
}

/** Clamp an arbitrary numeric verbosity into the supported 0/1/2 range. */
function normalizeVerbosity(value: number | undefined): VerbosityLevel {
    if (value === undefined) {
        return 0;
    }
    if (value >= 2) {
        return 2;
    }
    if (value <= 0) {
        return 0;
    }
    return 1;
}

function requireId(value: unknown, kind: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new ToolError(
            "InvalidArgument",
            `${kind} id is required and must be a non-empty string.`,
        );
    }
    if (!/^\d+$/.test(value)) {
        throw new ToolError(
            "InvalidArgument",
            `${kind} id must be a positive integer, got ${JSON.stringify(value)}.`,
        );
    }
    return value;
}
