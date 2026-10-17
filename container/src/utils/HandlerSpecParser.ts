import { TOPIC_PATTERN, ToolError } from "@getfamiliar/shared";

const TOPIC_REGEXP = new RegExp(TOPIC_PATTERN);

/**
 * Parse the `topic` the agent passed to `start_subagent` or
 * `schedule_subagent` into the canonical colon-separated topic. The
 * topic is the handler's whole address (`skills:memory:save` →
 * `skills/memory/save.md`).
 *
 * Models sometimes pass the handler's path instead of its topic. Rather
 * than fail and leave the agent to retry with reshuffled arguments, we
 * accept both shapes:
 *
 * - `skills:memory:save` — the canonical form, returned as-is.
 * - `skills/memory/save`, `/skills/memory/save`, `skills/memory/save.md`
 *   — `/` becomes `:`, a leading `/` and a trailing `.md`
 *   (case-insensitive) are dropped.
 * - `chat/telegram/index.md` — a trailing `index` path segment names the
 *   folder form of `chat:telegram`, so it is dropped too.
 *
 * @param rawTopic The `topic` argument the tool received.
 * @returns The canonical topic.
 * @throws {ToolError} `BadTopic` when the result does not match
 *   {@link TOPIC_PATTERN} (empty input, empty segments, spaces, …).
 */
export function parseHandlerTopic(rawTopic: string): string {
    const trimmed = rawTopic.trim();
    let topic = trimmed;
    if (trimmed.includes("/")) {
        const segments = stripMdExtension(trimmed).replace(/^\/+/, "").split("/");
        if (segments.length > 1 && segments[segments.length - 1] === "index") {
            segments.pop();
        }
        topic = segments.join(":");
    }
    if (!TOPIC_REGEXP.test(topic)) {
        throw new ToolError(
            "BadTopic",
            `topic "${rawTopic}" must be a colon-separated handler topic matching ${TOPIC_PATTERN} (e.g. "skills:memory:save")`,
        );
    }
    return topic;
}

/**
 * Drop a trailing `.md` (case-insensitive) from `value`. Returns the
 * original string when the suffix is absent.
 */
function stripMdExtension(value: string): string {
    if (value.length >= 3 && value.slice(-3).toLowerCase() === ".md") {
        return value.slice(0, -3);
    }
    return value;
}
