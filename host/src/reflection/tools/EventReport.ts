import {
    AgentRunBus,
    EventBus,
    type PluginTool,
    runTextTool,
    StepResultBus,
    ToolError,
} from "@getfamiliar/shared";
import {
    type AgentrunAggregate,
    aggregateSteps,
    renderAgentrunResult,
    renderAgentrunStart,
    renderEventCreated,
    renderEventResult,
    renderStepResult,
} from "../../reports/Renderers.js";
import type { ReflectionToolsDeps } from "../ReflectionTools.js";

interface EventReportArgs {
    readonly id?: string;
}

/**
 * Build the `event_report` reflection tool — the agent-facing slim
 * equivalent of `./cli.sh events report <id>`. Renders the event +
 * every agentrun's start / per-step / result section in `"slim"`
 * verbosity (no token tables, no system prompt, aggressive
 * truncation) so the report stays bounded for the model context.
 */
export function buildEventReportTool(
    deps: ReflectionToolsDeps,
): PluginTool<EventReportArgs, string> {
    return {
        name: "event_report",
        description:
            "Render a slim markdown report for one event: the event's metadata, every " +
            "agentrun's start + per-step trace + result, and the final outcome. Excludes " +
            "the resolved system prompt (use `agentrun_sysprompt` to fetch it) and token " +
            "tables, and truncates long prose / JSON. Pass the event `id` from `event_list`.",
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

                const sections: string[] = [];
                sections.push(renderEventCreated(event, "slim"));
                for (const run of runs) {
                    sections.push(renderAgentrunStart(run, {}, "slim"));
                    const runSteps = await steps.listByAgentRunId(run.id);
                    for (const step of runSteps) {
                        sections.push(renderStepResult(run, step, "slim"));
                    }
                    if (run.state === "done" || run.state === "failed") {
                        const aggregate: AgentrunAggregate = {
                            ...aggregateSteps(runSteps),
                            runtimeMs: Math.max(
                                0,
                                run.updatedAt.getTime() - run.createdAt.getTime(),
                            ),
                        };
                        sections.push(renderAgentrunResult(run, aggregate, "slim"));
                    }
                }
                if (event.state === "done" || event.state === "failed") {
                    sections.push(renderEventResult(event, runs, "slim"));
                }
                return sections.join("");
            }, callCtx.toolRunContext),
    };
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
