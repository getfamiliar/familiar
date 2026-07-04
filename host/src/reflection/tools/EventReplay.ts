import { EventBus, type PluginTool, runTextTool, ToolError } from "@getfamiliar/shared";
import { parseEventIdSpec } from "../../commands/EventIdSpec.js";
import { replayOne } from "../../events/ReplayEvent.js";
import type { ReflectionToolsDeps } from "../ReflectionTools.js";

interface EventReplayArgs {
    readonly ids?: string;
}

/**
 * Build the `event_replay` reflection tool — the agent-facing
 * equivalent of `./cli.sh events replay <id-spec>`. Accepts the same
 * comma-separated id / span spec the CLI does and re-emits each
 * resolved event as a fresh one. Per-id misses are reported inline
 * and skipped (matching the CLI), so a partial batch still surfaces
 * its successes.
 */
export function buildEventReplayTool(
    deps: ReflectionToolsDeps,
): PluginTool<EventReplayArgs, string> {
    return {
        name: "event_replay",
        level: "privileged",
        description:
            "Re-emit one or more existing events as fresh events. `ids` is a " +
            'comma-separated list of single ids and/or inclusive spans, e.g. `"4711"`, ' +
            '`"123-126"`, or `"123-126,555,560-570"`. Each replay copies the source\'s ' +
            "topic, prompt, payload, priority, chat flags, start-handler hint, and any " +
            "scratch files; appends `-replay` to the idempotency key so the copy is not " +
            "rejected by the original's dedup window. Ids that don't exist are reported " +
            "and skipped, the rest still run. Returns one line per id with the new id and " +
            "scratch-file count. Pick ids from `event_list` or `event_report`.",
        groups: ["reflection"],
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["ids"],
            properties: {
                ids: {
                    type: "string",
                    description:
                        'Event id, span, or comma-separated mix (e.g. "4711", "123-256", ' +
                        '"123-256,555,560-570").',
                },
            },
        },
        execute: (args, callCtx) =>
            runTextTool(async () => {
                const spec = requireSpec(args.ids);

                let targetIds: readonly string[];
                try {
                    targetIds = parseEventIdSpec(spec);
                } catch (err) {
                    throw new ToolError("InvalidArgument", (err as Error).message);
                }

                const connection = await deps.ensureConnection();
                const events = new EventBus(connection);

                const lines: string[] = [];
                for (const sourceId of targetIds) {
                    const source = await events.getById(sourceId);
                    if (!source) {
                        lines.push(`Event \`${sourceId}\` not found, skipped.`);
                        continue;
                    }
                    const { row, fileCount } = await replayOne(events, source, deps.scratchDir);
                    lines.push(
                        `Replayed event \`${sourceId}\` → \`${row.id}\` ` +
                            `(${fileCount} scratch file(s)).`,
                    );
                }
                return `${lines.join("\n")}\n`;
            }, callCtx.toolRunContext),
    };
}

/**
 * Validate the `ids` argument as a non-empty string. The deeper
 * parse / range checks live in `parseEventIdSpec`.
 *
 * @throws ToolError("InvalidArgument") when the value is missing or not a non-empty string.
 */
function requireSpec(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new ToolError(
            "InvalidArgument",
            "ids is required and must be a non-empty string id-spec.",
        );
    }
    return value;
}
