import {
    type AgentRunRow,
    type ChatMessage,
    type StepResultRow,
    unwrapToolCall,
} from "@getfamiliar/shared";
import type { ChatMessageDto, ChatRunDto, ChatStepDto, ChatToolCallDto } from "./ChatProtocol.js";

/** Longest tool input / output preview sent to the browser. */
const PREVIEW_LENGTH = 400;

/** Longest reasoning / step text sent to the browser. */
const TEXT_LENGTH = 4000;

/**
 * Project a stored chat message for the browser.
 *
 * @param message The message.
 * @returns The DTO.
 */
export function toMessageDto(message: ChatMessage): ChatMessageDto {
    return {
        id: message.id,
        eventId: message.eventId,
        role: message.role,
        text: message.textContent,
        createdAt: new Date(message.createdAt).toISOString(),
    };
}

/**
 * Project an agentrun row for the browser.
 *
 * @param row The row.
 * @returns The DTO.
 */
export function toRunDto(row: AgentRunRow): ChatRunDto {
    return {
        id: row.id,
        parentId: row.parentAgentrunId,
        topic: row.topic,
        model: row.model ?? null,
        state: row.state,
        error: row.error ?? null,
    };
}

/**
 * Project a finished step for the browser: reasoning and text (truncated)
 * and every tool call with a short argument / result preview. Calls
 * through the `tool_call` proxy show the invoked tool's name and arguments.
 *
 * @param step The step row.
 * @returns The DTO.
 */
export function toStepDto(step: StepResultRow): ChatStepDto {
    const results = new Map<string, { output: string; isError: boolean }>();
    for (const result of asRecords(step.toolResults)) {
        const id = typeof result.toolCallId === "string" ? result.toolCallId : null;
        if (id === null) {
            continue;
        }
        const isError = result.type === "tool-error";
        results.set(id, {
            output: preview(isError ? result.error : result.output, PREVIEW_LENGTH),
            isError,
        });
    }
    const tools: ChatToolCallDto[] = asRecords(step.toolCalls).map((call, index) => {
        const id = typeof call.toolCallId === "string" ? call.toolCallId : `call-${index}`;
        const { name, input } = unwrapToolCall(call);
        const result = results.get(id);
        return {
            id,
            name,
            input: preview(input, PREVIEW_LENGTH),
            output: result?.output ?? null,
            isError: result?.isError ?? false,
        };
    });
    return {
        agentRunId: step.agentRunId,
        stepNumber: step.stepNumber + 1,
        reasoning: nonEmpty(step.reasoningText, TEXT_LENGTH),
        text: nonEmpty(step.resultText, TEXT_LENGTH),
        tools,
    };
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
 * A short text preview of any value (strings as-is, the rest as JSON).
 *
 * @param value The value.
 * @param maxLength Cut-off length.
 * @returns The preview, with `…` when cut.
 */
export function preview(value: unknown, maxLength: number): string {
    let text: string;
    if (typeof value === "string") {
        text = value;
    } else {
        try {
            text = JSON.stringify(value) ?? String(value);
        } catch {
            text = String(value);
        }
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Trimmed, truncated text, or null when empty.
 *
 * @param text Text or nothing.
 * @param maxLength Cut-off length.
 * @returns The text or null.
 */
function nonEmpty(text: string | null | undefined, maxLength: number): string | null {
    const trimmed = text?.trim() ?? "";
    if (trimmed === "") {
        return null;
    }
    return preview(trimmed, maxLength);
}
