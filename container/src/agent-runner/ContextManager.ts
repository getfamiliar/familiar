import { estimateTokens, type Logger, type ToolRunContext } from "@getfamiliar/shared";
import type { ModelMessage } from "ai";

/**
 * Coarse per-message token surcharge accounting for role framing /
 * message delimiters the provider adds around every message. Added once
 * per message on top of its content estimate so short messages aren't
 * estimated as ~free.
 */
const PER_MESSAGE_TOKEN_OVERHEAD = 4;

/**
 * Tool results estimated below this many tokens are never moved to
 * scratch: the placeholder (path + preview) would cost about as much as
 * the result itself, and small results are exactly the ones a handler
 * keeps needing (a weather reading, a recovery score, …).
 */
const MIN_ELIDABLE_RESULT_TOKENS = 250;

/**
 * Coarse token estimate of one elision placeholder (tool name, trimmed
 * arguments, scratch path, preview). Used to price an elision before the
 * result is actually spilled.
 */
const PLACEHOLDER_TOKEN_ESTIMATE = 150;

/** Max characters of the result shown as a preview inside a placeholder. */
const PLACEHOLDER_PREVIEW_CHARS = 300;

/** Max characters of the call arguments shown inside a placeholder. */
const PLACEHOLDER_ARGS_CHARS = 200;

/**
 * Number of identical calls (same tool, same arguments) at which
 * {@link ContextManager.buildRepeatedCallNotice} starts nudging the agent
 * to stop re-calling and work with what it has.
 */
export const REPEATED_CALL_NOTICE_THRESHOLD = 3;

/** Writes contents to a scratch file and resolves to its absolute path. */
export type SpillFunction = ToolRunContext["spill"];

/** Options the {@link ContextManager} is constructed with, once per agentrun. */
export interface ContextManagerOptions {
    /**
     * The resolved model's context window in tokens, or `undefined` when
     * model metadata was unavailable. When undefined the sliding window
     * is a no-op and tool-result eviction measures against
     * {@link fallbackContextLimit} instead.
     */
    readonly contextLimit: number | undefined;
    /**
     * Context window assumed for tool-result eviction when
     * {@link contextLimit} is unknown, so a model without metadata still
     * gets its stale tool output moved out of the way.
     */
    readonly fallbackContextLimit: number;
    /**
     * Fraction of the context window at which context management kicks
     * in. Already clamped to `(0.3, 1.0)` by the caller. From
     * `inference.contextManagement.thresholdPercentage` (default 0.70).
     */
    readonly thresholdPercentage: number;
    /**
     * Estimated tokens of the static system prompt (`instructions`). The
     * SDK keeps the system prompt out of the `messages` array, but it
     * still consumes context, so it's counted toward usage.
     */
    readonly systemPromptTokens: number;
    /** Writes an elided tool result to scratch; see {@link SpillFunction}. */
    readonly spill: SpillFunction;
    /** Per-run logger (already tagged with agentrun lineage). */
    readonly log: Logger;
}

/**
 * Minimal structural view of a tool-result content part. The SDK's
 * `ToolResultPart` is internal; we only touch these fields.
 */
interface ToolResultPartLike {
    readonly type: "tool-result";
    readonly toolCallId: string;
    readonly toolName: string;
    readonly output: unknown;
}

/** What we remember about an assistant `tool-call` part. */
interface ToolCallInfo {
    readonly toolName: string;
    readonly input: unknown;
}

/** Type guard: is this content part a `tool-result`? */
function isToolResultPart(part: unknown): part is ToolResultPartLike {
    return (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "tool-result"
    );
}

/**
 * Active context-window manager for one agentrun's tool loop. Wired into
 * the `ToolLoopAgent`'s `prepareStep` callback: it rewrites the running
 * `messages` array before each step to keep the model's context from
 * being flooded by stale tool output.
 *
 * Everything is measured against one budget,
 * `thresholdPercentage * contextLimit`. Below it, the history passes
 * through untouched — small or few tool results are never thrown away.
 * The passes, applied in order:
 *
 *  1. **Dedup** (always): when the same tool was called with identical
 *     arguments more than once, every result but the newest is moved to
 *     scratch — it is redundant in context but stays readable on disk.
 *  2. **Evict to scratch** (over budget): the oldest large tool results
 *     are written to `/scratch/<event-id>/` and replaced with a
 *     placeholder naming the call, the file path and a short preview,
 *     until usage fits the budget. The newest tool message is never
 *     touched. `toolCallId` / `toolName` are preserved so the placeholder
 *     still pairs with its originating assistant tool-call.
 *  3. **Sliding window** (still over budget, context limit known): drop
 *     a contiguous span of the oldest messages — keeping the first two
 *     and the newest tail — and replace it with one `[elided N messages]`
 *     placeholder. The drop boundary is adjusted so an assistant
 *     tool-call and its tool-result are never split.
 *
 * `prepare` never mutates its input or the message objects it keeps.
 * Each result is spilled at most once per run; later steps reuse the
 * remembered path.
 */
export class ContextManager {
    /** Scratch path per spilled `toolCallId` (`null` when the spill failed). */
    private readonly spilledPaths = new Map<string, Promise<string | null>>();

    constructor(private readonly opts: ContextManagerOptions) {}

    /**
     * Apply all passes and return the rewritten message array.
     *
     * @param messages The SDK's current message array for the next step.
     * @returns A new, context-managed message array.
     */
    async prepare(messages: ModelMessage[]): Promise<ModelMessage[]> {
        const calls = this.buildToolCallInfo(messages);
        const toElide = this.selectDuplicateResults(messages, calls);
        this.selectResultsOverBudget(messages, toElide);
        const evicted = await this.elideResults(messages, toElide, calls);
        return this.applySlidingWindow(evicted);
    }

    /**
     * Build an ephemeral notice when the agent's latest step re-issued a
     * call (same tool, same arguments) for at least the
     * {@link REPEATED_CALL_NOTICE_THRESHOLD}th time — the signature of a
     * re-call loop. Meant to be appended to the step's messages next to
     * the step-budget notice.
     *
     * @param messages The SDK's current message array for the next step.
     * @returns The notice text, or `null` when nothing is repeated that often.
     */
    buildRepeatedCallNotice(messages: ModelMessage[]): string | null {
        const counts = new Map<string, number>();
        let latestKeys: Array<{ key: string; toolName: string }> = [];
        for (const message of messages) {
            if (message.role !== "assistant" || !Array.isArray(message.content)) {
                continue;
            }
            const keysInMessage: Array<{ key: string; toolName: string }> = [];
            for (const part of message.content) {
                const call = asToolCall(part);
                if (call === null) {
                    continue;
                }
                const key = callKey(call.toolName, call.input);
                counts.set(key, (counts.get(key) ?? 0) + 1);
                keysInMessage.push({ key, toolName: call.toolName });
            }
            if (keysInMessage.length > 0) {
                latestKeys = keysInMessage;
            }
        }
        const repeated = latestKeys
            .map(({ key, toolName }) => ({ toolName, count: counts.get(key) ?? 0 }))
            .filter(({ count }) => count >= REPEATED_CALL_NOTICE_THRESHOLD);
        if (repeated.length === 0) {
            return null;
        }
        const list = repeated.map(({ toolName, count }) => `${toolName} (${count}×)`).join(", ");
        return `You have now called ${list} with identical arguments several times. Its newest result is in your context and older copies were saved to the /scratch paths named in the placeholders. Do not call it again — work with what you already have and proceed towards your final output.`;
    }

    /**
     * Map every assistant `tool-call` part's `toolCallId` to its tool name
     * and input, for placeholders and duplicate detection.
     *
     * @param messages The message array.
     * @returns A map of tool-call id → call info.
     */
    private buildToolCallInfo(messages: ModelMessage[]): Map<string, ToolCallInfo> {
        const byId = new Map<string, ToolCallInfo>();
        for (const message of messages) {
            if (message.role !== "assistant" || !Array.isArray(message.content)) {
                continue;
            }
            for (const part of message.content) {
                const call = asToolCall(part);
                if (call !== null) {
                    byId.set(call.toolCallId, { toolName: call.toolName, input: call.input });
                }
            }
        }
        return byId;
    }

    /**
     * Select every large tool result that has a newer result for an
     * identical call (same tool, same arguments). Results whose call is
     * unknown (e.g. replayed history without the assistant turn) are
     * never treated as duplicates.
     *
     * @param messages The message array.
     * @param calls Call info by tool-call id.
     * @returns The set of tool-call ids whose results should be elided.
     */
    private selectDuplicateResults(
        messages: ModelMessage[],
        calls: Map<string, ToolCallInfo>,
    ): Set<string> {
        const toElide = new Set<string>();
        const seenKeys = new Set<string>();
        for (let i = messages.length - 1; i >= 0; i--) {
            const parts = toolResultParts(messages[i]);
            for (let j = parts.length - 1; j >= 0; j--) {
                const part = parts[j];
                const call = calls.get(part.toolCallId);
                if (call === undefined) {
                    continue;
                }
                const key = callKey(call.toolName, call.input);
                if (seenKeys.has(key) && this.isElidable(part)) {
                    toElide.add(part.toolCallId);
                }
                seenKeys.add(key);
            }
        }
        return toElide;
    }

    /**
     * When estimated usage (after the already-selected elisions) exceeds
     * the budget, add the oldest large tool results to `toElide` until it
     * fits. The newest tool message is never selected.
     *
     * @param messages The message array.
     * @param toElide Tool-call ids already selected; extended in place.
     */
    private selectResultsOverBudget(messages: ModelMessage[], toElide: Set<string>): void {
        const budget = this.budget(this.opts.contextLimit ?? this.opts.fallbackContextLimit);
        let total = this.opts.systemPromptTokens;
        for (const message of messages) {
            total += this.estimateMessageTokens(message);
        }
        for (const message of messages) {
            for (const part of toolResultParts(message)) {
                if (toElide.has(part.toolCallId)) {
                    total -= this.elisionSavings(part);
                }
            }
        }
        if (total <= budget) {
            return;
        }
        let lastToolIndex = -1;
        messages.forEach((m, i) => {
            if (m.role === "tool") {
                lastToolIndex = i;
            }
        });
        for (let i = 0; i < lastToolIndex && total > budget; i++) {
            for (const part of toolResultParts(messages[i])) {
                if (total <= budget) {
                    break;
                }
                if (toElide.has(part.toolCallId) || !this.isElidable(part)) {
                    continue;
                }
                toElide.add(part.toolCallId);
                total -= this.elisionSavings(part);
            }
        }
    }

    /**
     * Replace the output of every selected tool result with a placeholder
     * pointing at its spilled scratch file. Messages without a selected
     * result are returned as-is (same object).
     *
     * @param messages The message array.
     * @param toElide Tool-call ids whose results get elided.
     * @param calls Call info by tool-call id (for the placeholder text).
     * @returns A new array with the selected results elided.
     */
    private async elideResults(
        messages: ModelMessage[],
        toElide: Set<string>,
        calls: Map<string, ToolCallInfo>,
    ): Promise<ModelMessage[]> {
        if (toElide.size === 0) {
            return messages;
        }
        return Promise.all(
            messages.map(async (message) => {
                if (message.role !== "tool" || !Array.isArray(message.content)) {
                    return message;
                }
                if (
                    !message.content.some((p) => isToolResultPart(p) && toElide.has(p.toolCallId))
                ) {
                    return message;
                }
                const content = await Promise.all(
                    message.content.map(async (part) => {
                        if (!isToolResultPart(part) || !toElide.has(part.toolCallId)) {
                            return part;
                        }
                        const text = outputToText(part.output);
                        const path = await this.spillOnce(part, text);
                        return {
                            ...part,
                            output: {
                                type: "text",
                                value: buildPlaceholder(
                                    part,
                                    calls.get(part.toolCallId),
                                    text,
                                    path,
                                ),
                            },
                        };
                    }),
                );
                return { ...message, content } as ModelMessage;
            }),
        );
    }

    /**
     * Spill a tool result to scratch the first time it is elided and
     * remember the path for later steps. A failed spill is logged and
     * remembered as `null` so the placeholder can say so (and the write
     * isn't retried every step).
     *
     * @param part The tool-result part.
     * @param text The result rendered as text.
     * @returns The scratch path, or `null` when the spill failed.
     */
    private spillOnce(part: ToolResultPartLike, text: string): Promise<string | null> {
        const existing = this.spilledPaths.get(part.toolCallId);
        if (existing !== undefined) {
            return existing;
        }
        const suggestedName = `tool-result-${part.toolName.replace(/[^\w-]/g, "_")}.txt`;
        const pending = this.opts.spill(suggestedName, Buffer.from(text, "utf8")).then(
            (path) => {
                this.opts.log.debug(
                    { toolCallId: part.toolCallId, toolName: part.toolName, path },
                    `moved ${part.toolName} result (call ${part.toolCallId}) out of context to ${path}`,
                );
                return path;
            },
            (err: unknown) => {
                this.opts.log.warn(
                    { toolCallId: part.toolCallId, toolName: part.toolName, err },
                    `could not spill ${part.toolName} result (call ${part.toolCallId}) to scratch: ${err instanceof Error ? err.message : String(err)}`,
                );
                return null;
            },
        );
        this.spilledPaths.set(part.toolCallId, pending);
        return pending;
    }

    /**
     * Is this result big enough that replacing it with a placeholder
     * actually frees context?
     *
     * @param part The tool-result part.
     * @returns `true` when the result is at least {@link MIN_ELIDABLE_RESULT_TOKENS}.
     */
    private isElidable(part: ToolResultPartLike): boolean {
        return this.estimatePartTokens(part) >= MIN_ELIDABLE_RESULT_TOKENS;
    }

    /**
     * Estimated tokens freed by replacing a result with its placeholder.
     *
     * @param part The tool-result part.
     * @returns Estimated savings (never negative).
     */
    private elisionSavings(part: ToolResultPartLike): number {
        return Math.max(0, this.estimatePartTokens(part) - PLACEHOLDER_TOKEN_ESTIMATE);
    }

    /**
     * The token budget for a given context window.
     *
     * @param contextLimit Context window in tokens.
     * @returns `contextLimit * thresholdPercentage`.
     */
    private budget(contextLimit: number): number {
        return contextLimit * this.opts.thresholdPercentage;
    }

    /**
     * Drop the oldest messages once estimated usage still exceeds the
     * budget after tool-result eviction, keeping the first two messages and the newest tail
     * and inserting a single `[elided N messages]` placeholder for the
     * dropped span. No-op when no context budget is known or usage is
     * already within budget.
     *
     * @param messages The (already tool-result-evicted) message array.
     * @returns A new, possibly-shortened array, or the input unchanged.
     */
    private applySlidingWindow(messages: ModelMessage[]): ModelMessage[] {
        const { contextLimit, systemPromptTokens } = this.opts;
        if (contextLimit === undefined) {
            return messages;
        }
        const budget = this.budget(contextLimit);
        const perMessage = messages.map((m) => this.estimateMessageTokens(m));
        const total = systemPromptTokens + perMessage.reduce((acc, n) => acc + n, 0);
        if (total <= budget) {
            return messages;
        }

        // Protect the first two messages; always keep at least one tail
        // message (the newest turn). The drop span is [2, dropEnd).
        const maxDropEnd = messages.length - 1;
        let dropEnd = 2;
        let droppedTokens = 0;
        while (dropEnd < maxDropEnd) {
            const placeholderTokens = this.placeholderTokens(dropEnd - 2);
            if (total - droppedTokens + placeholderTokens <= budget) {
                break;
            }
            droppedTokens += perMessage[dropEnd];
            dropEnd++;
        }

        // Atomicity: never leave a tool message whose matching assistant
        // tool-call landed in the dropped span. Advance the boundary
        // forward past any such orphan (drop more, never less).
        dropEnd = this.adjustForAtomicity(messages, dropEnd, maxDropEnd);

        const droppedCount = dropEnd - 2;
        if (droppedCount <= 0) {
            this.opts.log.warn(
                { total, budget, contextLimit, messageCount: messages.length },
                `context (~${total} tokens) still over the ${Math.round(budget)}-token budget of ${contextLimit} after tool-result eviction, but nothing safe to drop`,
            );
            return messages;
        }

        const placeholder: ModelMessage = {
            role: "user",
            content: `[elided ${droppedCount} messages]`,
        };
        this.opts.log.debug(
            { total, budget, droppedCount, keptTail: messages.length - dropEnd },
            `sliding window dropped ${droppedCount} messages (~${total} tokens over the ${Math.round(budget)}-token budget)`,
        );
        return [messages[0], messages[1], placeholder, ...messages.slice(dropEnd)];
    }

    /**
     * Advance the drop boundary forward while the message at the boundary
     * is a tool message whose matching assistant tool-call falls inside
     * the dropped span `[2, dropEnd)` — dropping such an orphan along
     * with the rest so no kept tool-result references a dropped tool-call.
     *
     * @param messages The message array.
     * @param dropEnd The token-budget-derived boundary.
     * @param maxDropEnd Hard ceiling (keep at least one tail message).
     * @returns The adjusted boundary (>= the input).
     */
    private adjustForAtomicity(
        messages: ModelMessage[],
        dropEnd: number,
        maxDropEnd: number,
    ): number {
        const callIndexById = this.buildToolCallIndex(messages);
        let boundary = dropEnd;
        while (boundary < maxDropEnd) {
            const message = messages[boundary];
            if (message.role !== "tool" || !Array.isArray(message.content)) {
                break;
            }
            const hasOrphan = message.content.some((part) => {
                if (!isToolResultPart(part)) {
                    return false;
                }
                const callIdx = callIndexById.get(part.toolCallId);
                return callIdx !== undefined && callIdx >= 2 && callIdx < boundary;
            });
            if (!hasOrphan) {
                break;
            }
            boundary++;
        }
        return boundary;
    }

    /**
     * Map every assistant `tool-call` part's `toolCallId` to the index of
     * the message it appears in, for orphan detection.
     *
     * @param messages The message array.
     * @returns A map of tool-call id → containing message index.
     */
    private buildToolCallIndex(messages: ModelMessage[]): Map<string, number> {
        const byId = new Map<string, number>();
        messages.forEach((m, i) => {
            if (m.role !== "assistant" || !Array.isArray(m.content)) {
                return;
            }
            for (const part of m.content) {
                if (
                    typeof part === "object" &&
                    part !== null &&
                    (part as { type?: unknown }).type === "tool-call"
                ) {
                    const id = (part as { toolCallId?: unknown }).toolCallId;
                    if (typeof id === "string") {
                        byId.set(id, i);
                    }
                }
            }
        });
        return byId;
    }

    /**
     * Estimate the tokens a single message contributes, including a
     * per-message framing overhead.
     *
     * @param message The message to estimate.
     * @returns Estimated token count.
     */
    private estimateMessageTokens(message: ModelMessage): number {
        const content = message.content;
        if (typeof content === "string") {
            return estimateTokens(content) + PER_MESSAGE_TOKEN_OVERHEAD;
        }
        if (!Array.isArray(content)) {
            return PER_MESSAGE_TOKEN_OVERHEAD;
        }
        let sum = 0;
        for (const part of content) {
            sum += this.estimatePartTokens(part);
        }
        return sum + PER_MESSAGE_TOKEN_OVERHEAD;
    }

    /**
     * Estimate the tokens a single content part contributes.
     *
     * @param part A content part (text, reasoning, tool-call, tool-result, …).
     * @returns Estimated token count (0 for parts we don't price, e.g. files).
     */
    private estimatePartTokens(part: unknown): number {
        if (typeof part !== "object" || part === null) {
            return 0;
        }
        const p = part as { type?: unknown; text?: unknown; input?: unknown; toolName?: unknown };
        switch (p.type) {
            case "text":
            case "reasoning":
                return estimateTokens(typeof p.text === "string" ? p.text : "");
            case "tool-call":
                return (
                    estimateTokens(safeJsonString(p.input)) +
                    estimateTokens(typeof p.toolName === "string" ? p.toolName : "")
                );
            case "tool-result":
                return (
                    estimateTokens(safeJsonString((p as { output?: unknown }).output)) +
                    estimateTokens(typeof p.toolName === "string" ? p.toolName : "")
                );
            default:
                return 0;
        }
    }

    /**
     * Estimated token cost of the `[elided N messages]` placeholder plus
     * its per-message overhead. Folded into the budget check so dropping
     * never undershoots by ignoring the marker it adds.
     *
     * @param droppedCount Number of messages the placeholder stands in for.
     * @returns Estimated token count of the placeholder message.
     */
    private placeholderTokens(droppedCount: number): number {
        if (droppedCount <= 0) {
            return 0;
        }
        return estimateTokens(`[elided ${droppedCount} messages]`) + PER_MESSAGE_TOKEN_OVERHEAD;
    }
}

/**
 * JSON-stringify a value for token estimation, tolerating
 * non-serializable inputs (circular refs, BigInt) by falling back to a
 * coarse `String()`.
 *
 * @param value Any value.
 * @returns A string suitable for {@link estimateTokens}.
 */
function safeJsonString(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value) ?? "";
    } catch {
        return String(value);
    }
}

/**
 * Read an assistant `tool-call` content part, or `null` for anything else.
 *
 * @param part Any content part.
 * @returns The call's id, tool name and input, or `null`.
 */
function asToolCall(
    part: unknown,
): { toolCallId: string; toolName: string; input: unknown } | null {
    if (typeof part !== "object" || part === null) {
        return null;
    }
    const p = part as { type?: unknown; toolCallId?: unknown; toolName?: unknown; input?: unknown };
    if (
        p.type !== "tool-call" ||
        typeof p.toolCallId !== "string" ||
        typeof p.toolName !== "string"
    ) {
        return null;
    }
    return { toolCallId: p.toolCallId, toolName: p.toolName, input: p.input };
}

/**
 * Identity of a call for duplicate detection: tool name plus the
 * JSON-encoded arguments.
 *
 * @param toolName The called tool.
 * @param input The call arguments.
 * @returns A string key equal for identical calls.
 */
function callKey(toolName: string, input: unknown): string {
    return `${toolName}\u0000${safeJsonString(input)}`;
}

/**
 * The `tool-result` parts of a message (empty for non-tool messages).
 *
 * @param message Any message.
 * @returns Its tool-result parts in order.
 */
function toolResultParts(message: ModelMessage): ToolResultPartLike[] {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
        return [];
    }
    const content: readonly unknown[] = message.content;
    return content.filter(isToolResultPart);
}

/**
 * Render a tool-result `output` (the SDK's `ToolResultOutput` union) as
 * plain text for spilling and previews: text verbatim, JSON encoded,
 * content parts joined with non-text parts marked by their type.
 *
 * @param output The tool-result output.
 * @returns The output as text.
 */
function outputToText(output: unknown): string {
    if (typeof output !== "object" || output === null) {
        return safeJsonString(output);
    }
    const o = output as { type?: unknown; value?: unknown };
    switch (o.type) {
        case "text":
        case "error-text":
            return typeof o.value === "string" ? o.value : safeJsonString(o.value);
        case "json":
        case "error-json":
            return safeJsonString(o.value);
        case "content":
            if (Array.isArray(o.value)) {
                return o.value
                    .map((p: { type?: unknown; text?: unknown }) =>
                        p.type === "text" && typeof p.text === "string"
                            ? p.text
                            : `[${String(p.type)}]`,
                    )
                    .join("\n");
            }
            return safeJsonString(o.value);
        default:
            return safeJsonString(output);
    }
}

/**
 * Shorten `text` to `maxChars`, collapsing whitespace runs so the snippet
 * stays on one line.
 *
 * @param text The text to shorten.
 * @param maxChars Maximum characters kept.
 * @returns The shortened text, with `…` appended when cut.
 */
function snippet(text: string, maxChars: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}

/**
 * Build the placeholder that replaces an elided tool result: the call
 * (tool + trimmed arguments), the result size, where the full result now
 * lives, and a short preview. Worded so the agent reads the file instead
 * of re-calling the tool.
 *
 * @param part The elided tool-result part.
 * @param call The originating call, when known.
 * @param text The full result rendered as text.
 * @param path The scratch file holding the full result, or `null` when the spill failed.
 * @returns The placeholder text.
 */
function buildPlaceholder(
    part: ToolResultPartLike,
    call: ToolCallInfo | undefined,
    text: string,
    path: string | null,
): string {
    const args =
        call === undefined ? "" : snippet(safeJsonString(call.input), PLACEHOLDER_ARGS_CHARS);
    const sizeKb = (Buffer.byteLength(text, "utf8") / 1024).toFixed(1);
    const preview = snippet(text, PLACEHOLDER_PREVIEW_CHARS);
    const where =
        path === null
            ? "was removed from context to save space (saving it to scratch failed)"
            : `was moved to ${path} to save context — read it with fs_read or search it with bash instead of calling the tool again`;
    return `[${part.toolName}(${args}) result (${sizeKb} KB) was already received earlier in this run and ${where}. Preview: ${preview}]`;
}
