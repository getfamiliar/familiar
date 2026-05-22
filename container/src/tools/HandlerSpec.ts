import { TOPIC_PATTERN, ToolError } from "@getfamiliar/shared";

const TOPIC_REGEXP = new RegExp(TOPIC_PATTERN);

/**
 * Normalize the `topic` / `handler` pair the agent passed to `call_handler`
 * or `schedule_handler` into the canonical shape the rest of the stack
 * expects: a colon-separated topic and a bare handler basename.
 *
 * The agent sometimes packs the whole topic+basename into the `handler`
 * field (e.g. `handler: "mail/send-digest"`) instead of splitting it.
 * Rather than fail with `HandlerNotFound` and leave the agent to retry
 * with reshuffled arguments, we accept both shapes.
 *
 * Rules, applied in order:
 *
 * 1. Strip a trailing `.md` (case-insensitive) from `rawHandler` —
 *    `send-digest.md` → `send-digest`. Applied unconditionally.
 * 2. If the post-strip handler contains `/`: take the last segment as
 *    the basename. Preceding segments form a derived topic when joined
 *    with `:`. The derived topic is used only when `rawTopic` is
 *    undefined; an explicit `rawTopic` always wins, but the slashed
 *    handler is still flattened to its basename so the call succeeds.
 * 3. Otherwise the basename is `rawHandler` (post strip) and the topic
 *    is `rawTopic ?? fallbackTopic`.
 *
 * Empty basenames (`mail/`) or empty topic segments (`/index` with no
 * explicit topic, `mail//send`) throw {@link ToolError}("BadHandler", …).
 * A derived topic that fails the {@link TOPIC_PATTERN} regex throws
 * {@link ToolError}("BadTopic", …).
 *
 * @param rawTopic       The `topic` argument the tool received, or
 *                       `undefined` when omitted.
 * @param rawHandler     The `handler` argument the tool received.
 * @param fallbackTopic  Used when the agent supplied neither `rawTopic`
 *                       nor a slash in `rawHandler` — usually the
 *                       parent agentrun's topic.
 */
export function normalizeHandlerSpec(
    rawTopic: string | undefined,
    rawHandler: string,
    fallbackTopic: string,
): { topic: string; handler: string } {
    const stripped = stripMdExtension(rawHandler);

    if (!stripped.includes("/")) {
        if (stripped.length === 0) {
            throw new ToolError("BadHandler", "`handler` must not be empty");
        }
        const topic = rawTopic ?? fallbackTopic;
        if (!TOPIC_REGEXP.test(topic)) {
            throw new ToolError("BadTopic", `topic "${topic}" must match ${TOPIC_PATTERN}`);
        }
        return { topic, handler: stripped };
    }

    const segments = stripped.split("/");
    const basename = segments[segments.length - 1];
    if (basename.length === 0) {
        throw new ToolError(
            "BadHandler",
            `\`handler\` "${rawHandler}" ends with a separator — provide a basename after the last \`/\``,
        );
    }
    const topicSegments = segments.slice(0, -1);

    let topic: string;
    if (rawTopic !== undefined) {
        topic = rawTopic;
    } else {
        if (topicSegments.length === 0 || topicSegments.some((s) => s.length === 0)) {
            throw new ToolError(
                "BadHandler",
                `\`handler\` "${rawHandler}" cannot be parsed: missing or empty topic segment before the basename`,
            );
        }
        topic = topicSegments.join(":");
    }

    if (!TOPIC_REGEXP.test(topic)) {
        throw new ToolError("BadTopic", `topic "${topic}" must match ${TOPIC_PATTERN}`);
    }

    return { topic, handler: basename };
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
