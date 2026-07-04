/**
 * Cross-cutting constants for tool-group naming. A handler's `tools:`
 * frontmatter lists explicit tool names, `*`-globs, or group names;
 * the resolver lives in the container
 * (`container/src/tools/ToolsExpressionParser.ts`). The pieces
 * re-exported here are the ones the host-side `mcp.yml` linter and the
 * plugin tool registry also need to enforce — namely the reserved
 * group names and the shape every declarable name must match.
 *
 * Group names are otherwise *open*: any identifier matching
 * {@link IDENT_PATTERN} is a valid group, and a tool joins it by
 * listing the name in `PluginTool.groups`. The "predefined" groups
 * (`core`, `fs`, `reflection`, …) are not hardcoded sets — they
 * emerge from the union of every tool that declares them.
 */

/** Built-in group: every key in the available pool (system ∪ MCP). Reserved. */
export const ALL_GROUP_NAME = "all";

/** Built-in group: every MCP-tool key. Reserved. */
export const MCP_GROUP_NAME = "mcp";

/** Built-in group: empty set — used to override a parent's `tools:`. Reserved. */
export const NONE_GROUP_NAME = "none";

/**
 * Reserved plugin id for host-owned tools registered without a
 * plugin-id prefix (the "bare-key" path — `cal_get_events` rather
 * than `core_cal_get_events`). It is a **registration sentinel, not
 * an addressable tool group**: it deliberately collides in spelling
 * with the curated `core` group, so it must never be turned into a
 * plugin-id auto-group (doing so would shadow the curated `core`
 * group — the union of container built-ins and tools declaring
 * `groups: ["core"]` — with the full set of host-owned tools). Host
 * built-in tools join curated groups through their own `groups`
 * field (`["cal"]`, `["mail"]`, `["reflection"]`, …) instead.
 */
export const CORE_PLUGIN_ID = "core";

/**
 * Names the resolver handles directly and that therefore cannot
 * appear as a declarable group, an MCP id, or a plugin id. Using one
 * as an MCP id in `mcp.yml` is rejected by the loader; declaring it in
 * `PluginTool.groups` is rejected by the plugin tool registry.
 */
export const RESERVED_GROUP_NAMES: ReadonlySet<string> = new Set([
    ALL_GROUP_NAME,
    MCP_GROUP_NAME,
    NONE_GROUP_NAME,
]);

/**
 * Pattern any group name — declarable, MCP-id-derived, or
 * plugin-id-derived — must match.
 *
 * Lowercase alphanumeric only, leading letter, no underscores and
 * no hyphens. The exclusion of `_` is load-bearing: tool keys are
 * always shaped `${id}_${name}` (plugin tools) or a bare alnum-only
 * stem (built-ins) and contain at least one underscore in the
 * namespaced form, so an underscore-free bareword can never collide
 * with a tool key — the tool-group vs tool-pattern classifier in
 * `resolveTools` uses that to tell them apart structurally.
 */
export const IDENT_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * Validate a declared group name (used by the host plugin tool
 * registry and the container's built-in tool registration). Throws
 * with a self-contained message if the name is reserved or fails
 * {@link IDENT_PATTERN}.
 */
export function validateGroupName(name: string): void {
    if (!IDENT_PATTERN.test(name)) {
        throw new Error(
            `tool group name "${name}" is not a valid tool group name (must match ${IDENT_PATTERN})`,
        );
    }
    if (RESERVED_GROUP_NAMES.has(name)) {
        throw new Error(
            `tool group name "${name}" is a reserved tool group name (${[...RESERVED_GROUP_NAMES].join(", ")})`,
        );
    }
}
