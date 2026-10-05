import { toolPatternMatches } from "@getfamiliar/shared";
import type { McpEntry } from "./McpEntry.js";

/** The `mcp.yml` gating fields whose globs are checked against live tool names. */
export const TOOL_GATING_FIELDS = ["allowlist", "denylist", "approval", "privileged"] as const;

/** One of {@link TOOL_GATING_FIELDS}. */
export type ToolGatingField = (typeof TOOL_GATING_FIELDS)[number];

/** A gating glob in `mcp.yml` that matches none of the MCP's tools. */
export interface UnmatchedToolPattern {
    /** The `mcp.yml` field the pattern sits in. */
    readonly field: ToolGatingField;
    /** The pattern verbatim from `mcp.yml`. */
    readonly pattern: string;
    /**
     * Tool names that end with the pattern — the usual cause of a miss
     * is a server that prefixes its own tool names (e.g. totem reports
     * `whoop_profile_update`, so `profile_update` matches nothing).
     */
    readonly suggestions: readonly string[];
}

/**
 * Find every gating glob of an MCP entry that matches none of the tool
 * names the MCP server actually reports. Such a pattern is a silent
 * no-op at runtime — most often a typo or a missing server-side name
 * prefix — so `tools lint-mcps` surfaces it.
 *
 * Patterns are matched with the same anchored semantics the container
 * gating uses ({@link toolPatternMatches}), against the raw, unfiltered
 * tool list: a denylist entry that also misses the allowlist is still a
 * valid match here, since it names a real tool.
 *
 * @param entry The parsed `mcp.yml` entry whose gating fields are checked.
 * @param toolNames The bare tool names the MCP server reports via `listTools`.
 * @returns One record per unmatched pattern, in field order then file order.
 */
export function findUnmatchedToolPatterns(
    entry: Pick<McpEntry, ToolGatingField>,
    toolNames: readonly string[],
): UnmatchedToolPattern[] {
    const unmatched: UnmatchedToolPattern[] = [];
    for (const field of TOOL_GATING_FIELDS) {
        for (const pattern of entry[field]) {
            if (toolNames.some((name) => toolPatternMatches(pattern, name))) {
                continue;
            }
            const suggestions = toolNames.filter((name) => toolPatternMatches(`*${pattern}`, name));
            unmatched.push({ field, pattern, suggestions });
        }
    }
    return unmatched;
}
