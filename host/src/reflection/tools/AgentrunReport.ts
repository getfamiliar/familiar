import {
    AgentRunBus,
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
    renderStepResult,
} from "../../reports/Renderers.js";
import type { ReflectionToolsDeps } from "../ReflectionTools.js";

interface AgentrunReportArgs {
    readonly id?: string;
}

/**
 * Build the `agentrun_report` reflection tool — slim markdown view
 * of one agentrun (start + every step + result). Excludes the system
 * prompt; fetch it via `agentrun_sysprompt`.
 */
export function buildAgentrunReportTool(
    deps: ReflectionToolsDeps,
): PluginTool<AgentrunReportArgs, string> {
    return {
        name: "agentrun_report",
        description:
            "Render a slim markdown report for one agentrun: its start metadata, each step " +
            "(thinking, result, tool calls) in execution order, and the final result. " +
            "Excludes the system prompt and token tables; truncates long prose / JSON. Pass " +
            "the agentrun `id` from `event_report` or `event_list` -> `event_report`.",
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
                const runSteps = await steps.listByAgentRunId(run.id);

                const sections: string[] = [];
                sections.push(renderAgentrunStart(run, {}, "slim"));
                for (const step of runSteps) {
                    sections.push(renderStepResult(run, step, "slim"));
                }
                if (run.state === "done" || run.state === "failed") {
                    const aggregate: AgentrunAggregate = {
                        ...aggregateSteps(runSteps),
                        runtimeMs: Math.max(0, run.updatedAt.getTime() - run.createdAt.getTime()),
                    };
                    sections.push(renderAgentrunResult(run, aggregate, "slim"));
                }
                return sections.join("");
            }, callCtx.toolRunContext),
    };
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
