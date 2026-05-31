import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentRunBus, type PluginTool, runJsonTool, ToolError } from "@getfamiliar/shared";
import type { ReflectionToolsDeps } from "../ReflectionTools.js";

interface AgentrunSyspromptArgs {
    readonly id?: string;
}

/**
 * Build the `agentrun_sysprompt` reflection tool — saves the
 * resolved system prompt of one agentrun into the calling event's
 * scratch directory and returns the agent-side path. Lets the agent
 * read the (typically several-KB) prompt on demand via `fs_read`
 * instead of paying its cost in every report.
 *
 * Returns `{ path }`. Throws `SystemPromptUnavailable` when the
 * agentrun ran without `core.logSystemPrompt: true` and therefore
 * never persisted its prompt.
 */
export function buildAgentrunSyspromptTool(
    deps: ReflectionToolsDeps,
): PluginTool<AgentrunSyspromptArgs, object> {
    return {
        name: "agentrun_sysprompt",
        description:
            "Save the resolved system prompt of one agentrun into the calling event's " +
            "scratch dir and return the path the agent can `fs_read`. Returns `{ path }`. " +
            "Fails with SystemPromptUnavailable when the agentrun ran without " +
            "`core.logSystemPrompt: true` and never persisted its prompt.",
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
            runJsonTool(async () => {
                const id = requireId(args.id);

                const connection = await deps.ensureConnection();
                const agentruns = new AgentRunBus(connection);
                const run = await agentruns.getById(id);
                if (!run) {
                    throw new ToolError("AgentrunNotFound", `Agentrun ${id} not found.`);
                }
                if (run.systemPrompt === null || run.systemPrompt.length === 0) {
                    throw new ToolError(
                        "SystemPromptUnavailable",
                        `Agentrun ${id} has no persisted system prompt. ` +
                            "Set `core.logSystemPrompt: true` in config.yml and re-emit the " +
                            "event you want to inspect.",
                    );
                }

                const eventId = callCtx.event.id;
                const hostDir = path.join(deps.scratchDir, eventId);
                await fs.mkdir(hostDir, { recursive: true });
                const basename = `agentrun-${run.id}-sysprompt.md`;
                const hostPath = path.join(hostDir, basename);
                await fs.writeFile(hostPath, run.systemPrompt, "utf8");

                // The agent reads the file from inside the container, where
                // scratch is bind-mounted at `/scratch/<event-id>/`.
                return { path: `/scratch/${eventId}/${basename}` };
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
