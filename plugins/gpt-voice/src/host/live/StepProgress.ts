import { type StepResultRow, type UnwrappedToolCall, unwrapToolCall } from "@getfamiliar/shared";

/** Longest reasoning excerpt per progress note (the tail is kept). */
export const PROGRESS_REASONING_CHARS = 600;

/** Longest argument / error preview per tool call. */
export const PROGRESS_PREVIEW_CHARS = 120;

/** Tool whose messages are already spoken to the user (as commentary). */
const SEND_CHAT_TOOL = "send_chat";

/**
 * Describe a finished step of a background run as a silent progress note
 * for the voice model: the tail of the reasoning, the tools called (with
 * short arguments) and the tools that failed. Tool outputs are left out —
 * they are long, and the next step's reasoning sums them up.
 *
 * @param step The step row.
 * @param maxChars Upper bound of the note.
 * @returns The note, or null when the step carries nothing new: the final
 *   answer (delivered as the result) or a step that only called `send_chat`
 *   (already spoken).
 */
export function formatStepProgress(step: StepResultRow, maxChars: number): string | null {
    const calls = asRecords(step.toolCalls).map((call) => unwrapToolCall(call));
    const visibleCalls = calls.filter((call) => call.name !== SEND_CHAT_TOOL);
    if (calls.length === 0 && step.finishReason === "stop") {
        return null;
    }
    if (calls.length > 0 && visibleCalls.length === 0) {
        return null;
    }
    const parts: string[] = [];
    // Models without reasoning output often think aloud in the step's text.
    const reasoning =
        collapseWhitespace(step.reasoningText ?? "") || collapseWhitespace(step.resultText ?? "");
    if (reasoning !== "") {
        parts.push(`Thinking: ${tail(reasoning, PROGRESS_REASONING_CHARS)}`);
    }
    if (visibleCalls.length > 0) {
        const list = visibleCalls
            .map((call) => `${call.name} ${preview(call.input, PROGRESS_PREVIEW_CHARS)}`)
            .join("; ");
        parts.push(`Calling: ${list}`);
    }
    const failures = toolFailures(step.toolResults, calls);
    if (failures.length > 0) {
        parts.push(`Failed: ${failures.join("; ")}`);
    }
    if (parts.length === 0) {
        return null;
    }
    const note = `Background task progress (step ${step.stepNumber + 1}): ${parts.join(" | ")}`;
    return note.length > maxChars ? `${note.slice(0, maxChars - 1)}…` : note;
}

/**
 * The failed tool calls of a step as `name — error` previews.
 *
 * @param toolResults Raw `toolResults`.
 * @param calls The step's calls (for the unwrapped names).
 * @returns One entry per `tool-error` result.
 */
function toolFailures(toolResults: unknown, calls: readonly UnwrappedToolCall[]): string[] {
    return asRecords(toolResults)
        .filter((result) => result.type === "tool-error")
        .map((result) => {
            const call = calls.find((entry) => entry.id !== null && entry.id === result.toolCallId);
            const name =
                call?.name ?? (typeof result.toolName === "string" ? result.toolName : "tool");
            return `${name} — ${preview(result.error, PROGRESS_PREVIEW_CHARS)}`;
        });
}

/**
 * The object entries of an unknown array.
 *
 * @param value Raw `toolCalls` / `toolResults`.
 * @returns The records (non-objects dropped).
 */
function asRecords(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter(
        (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object",
    );
}

/**
 * A one-line preview of any value (strings as-is, the rest as JSON).
 *
 * @param value The value.
 * @param maxLength Cut-off length.
 * @returns The preview, with `…` when cut.
 */
function preview(value: unknown, maxLength: number): string {
    let text: string;
    if (typeof value === "string") {
        text = value;
    } else if (value instanceof Error) {
        text = value.message;
    } else {
        try {
            text = JSON.stringify(value) ?? String(value);
        } catch {
            text = String(value);
        }
    }
    text = collapseWhitespace(text);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * The last `maxLength` characters, starting at a word boundary when cut.
 *
 * @param text The text.
 * @param maxLength Limit.
 * @returns The tail, prefixed with `…` when cut.
 */
function tail(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
        return text;
    }
    const cut = text.slice(-maxLength);
    const space = cut.indexOf(" ");
    return `…${space > 0 && space < 40 ? cut.slice(space + 1) : cut}`;
}

/**
 * Collapse runs of whitespace (including newlines) into single spaces.
 *
 * @param text The text.
 * @returns Trimmed single-line text.
 */
function collapseWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}
