import { runJsonLinesTool, type ToolRunContext } from "@getfamiliar/shared";
import { jsonSchema, type Tool, tool } from "ai";

/** Metadata the `tool_list` tool searches and renders. */
export interface ToolCatalogEntry {
    /** Agent-facing tool key (`${id}_${name}` for MCP / plugin tools, bare for built-ins). */
    readonly name: string;
    /** Full tool description (searched in full; truncated for display). */
    readonly description: string;
}

interface ToolListInput {
    readonly search?: string;
}

/** How many characters of a description the listing shows before eliding. */
const DESCRIPTION_DISPLAY_LIMIT = 200;

/**
 * Build the `tool_list` discovery tool. Searches the *entire* tool
 * pool available this run — container built-ins, every connected MCP's
 * tools, and every plugin tool — not just the subset preloaded into the
 * agent's toolset. Pairs with `tool_call`, which invokes anything the
 * listing surfaces.
 *
 * The optional `search` is a case-insensitive substring matched against
 * each tool's name **and** full description. With no `search`, every
 * tool is listed. Output is one JSONL object per tool
 * (`{name, loaded, description}`), descriptions truncated to
 * {@link DESCRIPTION_DISPLAY_LIMIT} chars for compactness; `loaded`
 * flags the tools already in the agent's toolset (callable directly,
 * no `tool_call` needed).
 *
 * @param catalog Metadata for every tool in the run's pool.
 * @param loaded Keys already present in the agent's toolset this run.
 * @param ctx Per-call run context for oversized-output offloading.
 */
export function buildToolListTool(
    catalog: readonly ToolCatalogEntry[],
    loaded: ReadonlySet<string>,
    ctx: ToolRunContext,
): Tool<ToolListInput, string> {
    return tool<ToolListInput, string>({
        description:
            "Discover tools beyond the ones already loaded. Every handler run can reach every " +
            "tool; only a subset is preloaded into your toolset. Call this to search the full " +
            "pool, then invoke anything it returns with `tool_call`. Pass {search} as a " +
            "case-insensitive substring matched against tool names and descriptions, or omit " +
            "it to list everything. Each JSONL line is {name, loaded, description}; `loaded: " +
            "true` means the tool is already in your toolset and can be called directly.",
        inputSchema: jsonSchema<ToolListInput>({
            type: "object",
            additionalProperties: false,
            properties: {
                search: {
                    type: "string",
                    description:
                        "Case-insensitive substring to filter by (matched against tool name and " +
                        "description). Omit to list every available tool.",
                },
            },
        }),
        execute: ({ search }) =>
            runJsonLinesTool(async () => {
                const needle = search?.trim().toLowerCase();
                const matches = catalog.filter(
                    (entry) =>
                        needle === undefined ||
                        needle.length === 0 ||
                        entry.name.toLowerCase().includes(needle) ||
                        entry.description.toLowerCase().includes(needle),
                );
                return matches.map((entry) => ({
                    name: entry.name,
                    loaded: loaded.has(entry.name),
                    description: truncateForDisplay(entry.description),
                }));
            }, ctx),
    });
}

/** Elide a description to {@link DESCRIPTION_DISPLAY_LIMIT} chars with a trailing `…`. */
function truncateForDisplay(description: string): string {
    if (description.length <= DESCRIPTION_DISPLAY_LIMIT) {
        return description;
    }
    return `${description.slice(0, DESCRIPTION_DISPLAY_LIMIT).trimEnd()}…`;
}
