import { estimateTokens, type Logger } from "@getfamiliar/shared";
import type { ModelMessage } from "ai";

/**
 * Coarse per-message token surcharge accounting for role framing /
 * message delimiters the provider adds around every message. Added once
 * per message on top of its content estimate so short messages aren't
 * estimated as ~free.
 */
const PER_MESSAGE_TOKEN_OVERHEAD = 4;

/** Options the {@link ContextManager} is constructed with, once per agentrun. */
export interface ContextManagerOptions {
    /**
     * The resolved model's context window in tokens, or `undefined` when
     * model metadata was unavailable. When undefined the sliding window
     * is a no-op (no budget to compare against) — only tool-result
     * eviction runs.
     */
    readonly contextLimit: number | undefined;
    /**
     * Tool results from the last N steps are kept verbatim; older ones
     * are elided to a short placeholder. From
     * `inference.contextManagement.keptToolResultCount` (default 3).
     */
    readonly keptToolResultCount: number;
    /**
     * Fraction of `contextLimit` at which the sliding window kicks in.
     * Already clamped to `(0.3, 1.0)` by the caller. From
     * `inference.contextManagement.slidingWindowPercentage` (default 0.70).
     */
    readonly slidingWindowPercentage: number;
    /**
     * Estimated tokens of the static system prompt (`instructions`). The
     * SDK keeps the system prompt out of the `messages` array, but it
     * still consumes context, so it's counted toward usage when deciding
     * whether the window must drop messages.
     */
    readonly systemPromptTokens: number;
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
 * Two independent passes, applied in order:
 *
 *  1. **Evict old tool results** (always, size-independent): only the
 *     last {@link ContextManagerOptions.keptToolResultCount} tool
 *     messages keep their result content; older ones are replaced with a
 *     short `[<tool> result elided - re-call if needed]` marker. The
 *     `toolCallId` / `toolName` are preserved so the elided result still
 *     pairs with its originating assistant tool-call.
 *  2. **Sliding window** (size-gated): once estimated usage crosses
 *     `slidingWindowPercentage * contextLimit`, drop a contiguous span
 *     of the oldest messages — keeping the first two and the newest tail
 *     — and replace the dropped span with one `[elided N messages]`
 *     placeholder. The drop boundary is adjusted so an assistant
 *     tool-call and its tool-result are never split.
 *
 * `prepare` is pure: it returns a new array and never mutates its input
 * or the message objects it keeps.
 */
export class ContextManager {
    constructor(private readonly opts: ContextManagerOptions) {}

    /**
     * Apply both passes and return the rewritten message array.
     *
     * @param messages The SDK's current message array for the next step.
     * @returns A new, context-managed message array.
     */
    prepare(messages: ModelMessage[]): ModelMessage[] {
        const evicted = this.evictOldToolResults(messages);
        return this.applySlidingWindow(evicted);
    }

    /**
     * Replace the result content of every tool message older than the
     * last {@link ContextManagerOptions.keptToolResultCount} with a short
     * placeholder, leaving recent results and all assistant tool-call
     * messages intact. Runs every step regardless of context size.
     *
     * @param messages The message array to process.
     * @returns A new array with old tool-result outputs elided (or the
     *   input array unchanged when there are at most N tool messages).
     */
    private evictOldToolResults(messages: ModelMessage[]): ModelMessage[] {
        const toolIndices: number[] = [];
        messages.forEach((m, i) => {
            if (m.role === "tool") {
                toolIndices.push(i);
            }
        });
        if (toolIndices.length <= this.opts.keptToolResultCount) {
            return messages;
        }
        const elideBefore = toolIndices.length - this.opts.keptToolResultCount;
        const toElide = new Set(toolIndices.slice(0, elideBefore));
        return messages.map((m, i) => (toElide.has(i) ? this.elideToolMessage(m) : m));
    }

    /**
     * Shallow-clone a tool message, replacing each `tool-result` part's
     * `output` with a text placeholder. `toolCallId` / `toolName` are
     * preserved so the message still pairs with its assistant tool-call.
     *
     * @param message A `role:'tool'` message.
     * @returns A new message with elided result outputs.
     */
    private elideToolMessage(message: ModelMessage): ModelMessage {
        const content = message.content;
        if (!Array.isArray(content)) {
            return message;
        }
        const elided = content.map((part) => {
            if (!isToolResultPart(part)) {
                return part;
            }
            return {
                ...part,
                output: {
                    type: "text",
                    value: `[${part.toolName} result elided - re-call if needed]`,
                },
            };
        });
        return { ...message, content: elided } as ModelMessage;
    }

    /**
     * Drop the oldest messages once estimated usage exceeds the sliding
     * window budget, keeping the first two messages and the newest tail
     * and inserting a single `[elided N messages]` placeholder for the
     * dropped span. No-op when no context budget is known or usage is
     * already within budget.
     *
     * @param messages The (already tool-result-evicted) message array.
     * @returns A new, possibly-shortened array, or the input unchanged.
     */
    private applySlidingWindow(messages: ModelMessage[]): ModelMessage[] {
        const { contextLimit, slidingWindowPercentage, systemPromptTokens } = this.opts;
        if (contextLimit === undefined) {
            return messages;
        }
        const budget = contextLimit * slidingWindowPercentage;
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
                "context over sliding-window budget but nothing safe to drop",
            );
            return messages;
        }

        const placeholder: ModelMessage = {
            role: "user",
            content: `[elided ${droppedCount} messages]`,
        };
        this.opts.log.debug(
            { total, budget, droppedCount, keptTail: messages.length - dropEnd },
            "sliding window dropped messages",
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
