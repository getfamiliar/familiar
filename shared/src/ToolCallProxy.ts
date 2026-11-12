/**
 * Agent-facing key of the `tool_call` proxy tool, which invokes another
 * tool by name (`{name, arguments}`). Tools reached through it show up in
 * a step's `toolCalls` under this name.
 */
export const TOOL_CALL_PROXY_NAME = "tool_call";

/** A step's tool call with the `tool_call` proxy unwrapped. */
export interface UnwrappedToolCall {
    /** The AI SDK tool-call id, or null when absent. */
    readonly id: string | null;
    /** The invoked tool's name (the proxied target for `tool_call`). */
    readonly name: string;
    /** The invoked tool's arguments. */
    readonly input: unknown;
}

/**
 * Name and arguments of a raw AI SDK tool call (an entry of a step's
 * `toolCalls`), unwrapping the `tool_call` proxy so callers see the tool
 * that really ran. A proxy call without a string `name` stays as it is.
 *
 * @param call Raw tool call (`{ toolCallId, toolName, input }`).
 * @returns Id, tool name and input; `"tool"` when the name is missing.
 */
export function unwrapToolCall(call: Readonly<Record<string, unknown>>): UnwrappedToolCall {
    const id = typeof call.toolCallId === "string" ? call.toolCallId : null;
    const name = typeof call.toolName === "string" ? call.toolName : "tool";
    const input = call.input;
    if (name === TOOL_CALL_PROXY_NAME && input !== null && typeof input === "object") {
        const proxied = input as { name?: unknown; arguments?: unknown };
        if (typeof proxied.name === "string") {
            return { id, name: proxied.name, input: proxied.arguments ?? {} };
        }
    }
    return { id, name, input };
}
