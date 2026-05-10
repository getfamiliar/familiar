/**
 * Resolves the text we hand back to {@link AgentRunBus.settle} after
 * `agent.generate()` returns. Normally this is just the SDK's
 * aggregated `result.text`, but a handful of finish reasons
 * regularly produce an empty aggregate while the per-step record
 * shows the model *did* emit text or reasoning earlier in the loop.
 * Returning `""` then strands operators and parent agentruns with no
 * clue what happened. We synthesize a useful result string instead:
 * a hardcoded prefix (naming the finish reason and pointing at the
 * usual operator action) followed by the last step's text or
 * reasoning.
 *
 * Targeted finish reasons:
 *
 * - `other`  — provider/tool-wiring problem; transient or schema issue.
 *              Synthesizes only when `result.text` is empty.
 * - `length` — `maxOutputTokens` too low; raise it. **Always** prefixes,
 *              because some providers deliver a (truncated) `result.text`
 *              and we want the operator to see the truncation reason
 *              regardless. Body is `result.text` when present, else the
 *              walk-back fallback.
 * - `stop`   — model finished cleanly but never produced a final reply
 *              (typically: ran tools to completion, then said nothing).
 *              Synthesizes only when `result.text` is empty.
 *
 * Non-targeted finish reasons pass through untouched, including their
 * empty-text case — we don't want to invent reply text for completion
 * shapes we haven't deliberately opted into.
 */

/**
 * Hardcoded prefix appended when a targeted finish reason had no
 * aggregated `result.text`. Shape matches `${prefix}\n\n${body}` —
 * the blank line keeps logs and chat readable.
 */
export const OTHER_PREFIX =
    'The model stopped the process with reason "other", this usually points to a server-side problem or trouble with the tool wiring. The last thought or utterance of the model was:';

/** See {@link OTHER_PREFIX}. */
export const LENGTH_PREFIX =
    "The model stopped because the max output tokens limit was reached. You may consider raising it (maxOutputTokens in the .md file). The last thought or utterance of the model was:";

/** See {@link OTHER_PREFIX}. */
export const STOP_PREFIX =
    "The model finished without producing a final reply. The last thought or utterance of the model was:";

/** Body used when no preceding step produced text or reasoning. */
export const NO_PRECEDING_BODY = "(no preceding text or reasoning was produced)";

const PREFIX_BY_FINISH_REASON: Readonly<Record<string, string>> = {
    other: OTHER_PREFIX,
    length: LENGTH_PREFIX,
    stop: STOP_PREFIX,
};

/**
 * Minimal structural shape pulled out of the AI SDK's `GenerateResult`.
 * Kept local so this helper stays SDK-agnostic and trivially testable.
 */
export interface SynthesizeInput {
    readonly text: string;
    readonly finishReason: string;
    readonly steps: ReadonlyArray<{
        readonly text?: string;
        readonly reasoningText?: string | undefined;
    }>;
}

/**
 * Compute the result text to persist on the agentrun.
 *
 * - `length`: always {@link LENGTH_PREFIX} + body. Body is the
 *   trimmed `result.text` when non-empty, otherwise the last step's
 *   text/reasoning, otherwise {@link NO_PRECEDING_BODY}. Some
 *   providers deliver a truncated reply with `finishReason: length`,
 *   and we want the truncation context attached either way.
 * - `other` / `stop`: when `result.text` is non-empty, return it
 *   verbatim (no synthesis). When empty, prefix + walk-back body
 *   exactly like the `length` empty case.
 * - All other finish reasons: return `result.text` unchanged,
 *   preserving today's behaviour (including silent empty
 *   completions on `tool-calls`, `content-filter`, etc.).
 */
export function synthesizeResultText(result: SynthesizeInput): string {
    const prefix = PREFIX_BY_FINISH_REASON[result.finishReason];
    if (prefix === undefined) {
        return result.text;
    }
    if (result.finishReason !== "length" && result.text.trim().length > 0) {
        return result.text;
    }
    const trimmedText = result.text.trim();
    const body =
        trimmedText.length > 0
            ? trimmedText
            : (lastStepTextOrReasoning(result.steps) ?? NO_PRECEDING_BODY);
    return `${prefix}\n\n${body}`;
}

/**
 * Walk steps from the end. On each step, prefer trimmed `text`,
 * falling back to trimmed `reasoningText`. Returns `undefined` when
 * no step has either.
 */
function lastStepTextOrReasoning(
    steps: ReadonlyArray<{ readonly text?: string; readonly reasoningText?: string | undefined }>,
): string | undefined {
    for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        const text = step?.text?.trim();
        if (text && text.length > 0) {
            return text;
        }
        const reasoning = step?.reasoningText?.trim();
        if (reasoning && reasoning.length > 0) {
            return reasoning;
        }
    }
    return undefined;
}
