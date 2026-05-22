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

interface CallHandlerInput {
    readonly topic?: string;
    readonly handler: string;
    readonly prompt?: string;
    readonly payload?: Record<string, unknown>;
}

/**
 * Callback the Scheduler binds to each runner — when invoked, the
 * Scheduler flips the parent agentrun to `state='waiting'`, pauses
 * its timeout, and returns a Promise that resolves with the child's
 * settled row once **every** `calltype='called'` child of the parent
 * has reached `done`/`failed`. The resolved row is specifically the
 * child this call was waiting on.
 */
export type WaitForSubagent = (childId: string) => Promise<AgentRunRow>;

/**
 * Build the `call_handler` tool for one agentrun. Spawns a child
 * agentrun and **suspends** the current run until the child settles,
 * then returns the child's `resultText` as the tool's text result.
 *
 * Unlike `schedule_handler` (fire-and-forget when called without
 * `when`), the caller awaits and receives the subagent's output —
 * making it possible to react to the result. The parent's watcher
 * slot is released while suspended, so the child can run (and any
 * other unrelated agentruns can interleave) without holding the
 * parent's slot for the full duration.
 *
 * The child inherits `event_id`, `priority`, and `privileged` from
 * the parent and is tagged `calltype='called'`. Topic defaults to
 * the parent's topic when omitted.
 *
 * Errors during child insertion, handler resolution, or a failed
 * subagent throw a {@link ToolError}; the AI SDK then emits a
 * `tool-error` block so the calling handler can decide how to react
 * (read the failure message, pick a different handler, etc.).
 */
export function buildCallHandlerTool(
    bus: AgentRunBus,
    parent: AgentRunRow,
    waitForSubagent: WaitForSubagent,
    ctx: ToolRunContext,
): Tool<CallHandlerInput, string> {
    return tool<CallHandlerInput, string>({
        description:
            "Spawn a subagent and WAIT for its result. The current agentrun suspends; once the " +
            "subagent settles, this tool returns the subagent's final text. Use " +
            "`schedule_handler` (without `when`) instead when you don't need the subagent's " +
            "output. Topic defaults to the current agentrun's topic; override with the `topic` " +
            "argument to call cross-topic. Inherits the event and trust level from this run. " +
            "If the subagent fails, the tool surfaces an error so the calling handler can " +
            "decide how to react.",
        inputSchema: jsonSchema<CallHandlerInput>({
            type: "object",
            additionalProperties: false,
            required: ["handler"],
            properties: {
                topic: {
                    type: "string",
                    description:
                        "Optional topic for the called subagent. Defaults to the current " +
                        "agentrun's topic.",
                },
                handler: {
                    type: "string",
                    description:
                        "Handler basename without `.md`, e.g. `analyze` or `respond`. Resolved " +
                        "against `topic` (or the current topic when omitted).",
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
        execute: ({ topic, handler, prompt, payload }) =>
            runTextTool(async () => {
                const resolvedTopic = topic ?? parent.topic;

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
                    HandlerFile.load(resolvedTopic, handler);
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
                        handler,
                        priority: parent.priority,
                        prompt: prompt ?? null,
                        payload: payload ?? {},
                        privileged: parent.privileged,
                        calltype: "called",
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
