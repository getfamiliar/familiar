import type { Tool } from "ai";

/**
 * Resolve a tool's description to plain text.
 *
 * Since AI SDK 7, `Tool.description` may be a function of the tool's
 * per-call `context`. We never pass a `toolsContext`, so the SDK would call
 * such a function with `context: undefined`, and this does the same. All of
 * our own tools and the MCP / host tools use plain strings; the function
 * branch only exists so a dynamic description still renders in the catalog,
 * in `tool_describe` and in the clamped definition the model sees.
 *
 * @param target The tool whose description to read.
 * @returns The description text, or `undefined` when the tool has none.
 */
export function toolDescriptionText(target: Pick<Tool, "description">): string | undefined {
    const description = target.description;
    if (typeof description === "function") {
        return description({ context: undefined });
    }
    return description;
}
