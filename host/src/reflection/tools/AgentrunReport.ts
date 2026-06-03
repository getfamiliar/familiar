import {
    AgentRunBus,
    type PluginTool,
    runTextTool,
    StepResultBus,
    type StepResultRow,
    ToolError,
} from "@getfamiliar/shared";
import { renderAgentrunReport, type VerbosityLevel } from "../../reports/Renderers.js";
import type { ReflectionToolsDeps } from "../ReflectionTools.js";

interface AgentrunReportArgs {
    readonly id?: string;
    readonly verbosity?: number;
    readonly truncate?: boolean;
}

/**
 * Build the `agentrun_report` reflection tool — a hierarchical markdown
 * view of one agentrun and its descendants (each subagent nested inline
 * at the step that spawned it). `verbosity` (0/1/2) and `truncate`
 * (default `true`) work exactly as on `event_report`.
 */
export function buildAgentrunReportTool(
    deps: ReflectionToolsDeps,
): PluginTool<AgentrunReportArgs, string> {
    return {
        name: "agentrun_report",
        description:
            "Render a markdown report for one agentrun: its start metadata, each step (thinking, " +
            "tool calls, result) in order with any spawned subagents nested inline, and the final " +
            "result. `verbosity` 0 (default) shows the step protocol; 1 adds token tables and the " +
            "system prompt; 2 also adds full tool-call I/O and the initial message history. " +
            "`truncate` (default true) caps long prose / JSON. Pass the agentrun `id` from " +
            "`event_report` or `event_list` -> `event_report`.",
        groups: ["reflection"],
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: {
                id: {
                    type: "string",
                    description: "Agentrun id (the bigserial PK from the agentruns table).",
                },
                verbosity: {
                    type: "integer",
                    enum: [0, 1, 2],
                    description:
                        "Detail level: 0 step protocol; 1 + token tables + system prompt; 2 + " +
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
                const id = requireId(args.id);

                const connection = await deps.ensureConnection();
                const agentruns = new AgentRunBus(connection);
                const steps = new StepResultBus(connection);

                const run = await agentruns.getById(id);
                if (!run) {
                    throw new ToolError("AgentrunNotFound", `Agentrun ${id} not found.`);
                }

                // The renderer needs the run's descendant subtree to nest
                // subagents. Fetch the event's full run set and let
                // renderAgentrunReport reach only the runs descending from
                // `run`; build steps for all of them.
                const runs = await agentruns.listByEventId(run.eventId);
                const stepsByRun = new Map<string, readonly StepResultRow[]>();
                for (const r of runs) {
                    stepsByRun.set(r.id, await steps.listByAgentRunId(r.id));
                }

                return renderAgentrunReport(run, runs, stepsByRun, {
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

function requireId(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new ToolError(
            "InvalidArgument",
            "agentrun id is required and must be a non-empty string.",
        );
    }
    if (!/^\d+$/.test(value)) {
        throw new ToolError(
            "InvalidArgument",
            `agentrun id must be a positive integer, got ${JSON.stringify(value)}.`,
        );
    }
    return value;
}
