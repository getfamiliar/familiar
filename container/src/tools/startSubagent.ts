import {
    type AgentRunBus,
    type AgentRunRow,
    runTextTool,
    ToolError,
    type ToolRunContext,
} from "@getfamiliar/shared";
import type { Tool } from "ai";
import { jsonSchema, tool } from "ai";
import { HandlerFile } from "../HandlerFile.js";
import { parseHandlerTopic } from "../utils/HandlerSpecParser.js";
import type { NoToolContext } from "./NoToolContext.js";

interface StartSubagentInput {
    readonly topic: string;
    readonly prompt?: string;
    readonly payload?: Record<string, unknown>;
}

/**
 * Callback the Scheduler binds to each runner — when invoked, the
 * Scheduler flips the parent agentrun to `state='waiting'`, pauses
 * its timeout, and returns a Promise that resolves with the child's
 * settled row once **every** `calltype='started'` child of the parent
 * has reached `done`/`failed`. The resolved row is specifically the
 * child this call was waiting on.
 */
export type WaitForSubagent = (childId: string) => Promise<AgentRunRow>;

/**
 * Build the `start_subagent` tool for one agentrun. Spawns a child
 * agentrun in its own fresh context and **suspends** the current run
 * until the child settles, then returns the child's `resultText` as
 * the tool's text result.
 *
 * A subagent is not needed to reach a tool — every tool is directly
 * callable. Start one when you want isolation: an empty context, or a
 * different model / tool set (both taken from the target handler's
 * frontmatter). Parallel fan-out is planned.
 *
 * Unlike `schedule_subagent` (fire-and-forget when called without
 * `when`), the caller awaits and receives the subagent's output —
 * making it possible to react to the result. The parent's watcher
 * slot is released while suspended, so the child can run (and any
 * other unrelated agentruns can interleave) without holding the
 * parent's slot for the full duration.
 *
 * The child inherits `event_id`, `priority`, and `privileged` from
 * the parent and is tagged `calltype='started'`. Its `topic` names the
 * target handler exactly — there is no fallback up the topic chain.
 *
 * Errors during child insertion, handler resolution, or a failed
 * subagent throw a {@link ToolError}; the AI SDK then emits a
 * `tool-error` block so the calling handler can decide how to react
 * (read the failure message, pick a different handler, etc.).
 */
export function buildStartSubagentTool(
    bus: AgentRunBus,
    parent: AgentRunRow,
    waitForSubagent: WaitForSubagent,
    ctx: ToolRunContext,
): Tool<StartSubagentInput, string> {
    return tool<StartSubagentInput, string, NoToolContext>({
        description:
            "Start a subagent to run a target handler in its own fresh context, and WAIT for its " +
            "result. The current agentrun suspends; once the subagent settles, this tool returns " +
            "the subagent's final text. A subagent is NOT needed to reach a tool — every tool is " +
            "directly callable. Start one for isolation: an empty context, or a different model / " +
            "tool set (both taken from the target handler's frontmatter). Parallel fan-out is " +
            "planned. Use `schedule_subagent` (without `when`) instead when you don't need the " +
            "subagent's output. `topic` is the target handler's address and must match a handler " +
            'file exactly: `topic: "mail:whatsapp:send"` runs `mail/whatsapp/send.md` (or ' +
            "`mail/whatsapp/send/index.md`); the path form `mail/whatsapp/send.md` is accepted " +
            "too. Inherits the event and trust level from this run. If the subagent " +
            "fails, the tool surfaces an error so the calling handler can decide how to react.",
        inputSchema: jsonSchema<StartSubagentInput>({
            type: "object",
            additionalProperties: false,
            required: ["topic"],
            properties: {
                topic: {
                    type: "string",
                    description:
                        "Topic of the handler to run, e.g. `mail:analyze` for `mail/analyze.md`. " +
                        "Must match a handler file exactly.",
                },
                prompt: {
                    type: "string",
                    description:
                        "Optional short instruction for the subagent, surfaced as the trailing " +
                        "user message in its prompt.",
                },
                payload: {
                    type: "object",
                    additionalProperties: true,
                    description: "Optional JSON object passed to the subagent as structured input.",
                },
            },
        }),
        execute: ({ topic, prompt, payload }) =>
            runTextTool(async () => {
                const resolvedTopic = parseHandlerTopic(topic);

                if (payload !== undefined) {
                    let serialized: string | undefined;
                    try {
                        serialized = JSON.stringify(payload);
                    } catch (err) {
                        throw new ToolError(
                            "InvalidPayload",
                            `payload must be JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                    if (serialized === undefined) {
                        throw new ToolError(
                            "InvalidPayload",
                            "payload must be JSON-serializable (must not contain functions, symbols, or undefined at the root)",
                        );
                    }
                }

                try {
                    HandlerFile.load(resolvedTopic, { isExactTopic: true });
                } catch (err) {
                    throw new ToolError(
                        "HandlerNotFound",
                        err instanceof Error ? err.message : String(err),
                    );
                }

                let child: AgentRunRow;
                try {
                    child = await bus.add({
                        eventId: parent.eventId,
                        parentAgentrunId: parent.id,
                        topic: resolvedTopic,
                        isExactTopic: true,
                        priority: parent.priority,
                        prompt: prompt ?? null,
                        payload: payload ?? {},
                        privileged: parent.privileged,
                        calltype: "started",
                    });
                } catch (err) {
                    throw new ToolError(
                        "SubagentSpawnFailed",
                        `failed to spawn subagent: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }

                const settled = await waitForSubagent(child.id);

                if (settled.state === "done") {
                    return settled.resultText ?? "";
                }
                throw new ToolError(
                    "SubagentFailed",
                    settled.error ?? "subagent failed without an error message",
                );
            }, ctx),
    });
}
