/**
 * Cross-cutting constants for the tools-DSL — the small expression
 * language used in handler markdown frontmatter (`tools:`) and in
 * `workspace/toolgroups/*.txt` files. The full parser/evaluator
 * lives in the container (`container/src/tools/ToolFilter.ts`); the
 * pieces re-exported here are the ones the host-side `mcp.yml`
 * linter and the plugin tool registry also need to enforce — namely
 * the set of group names the evaluator reserves and the shape every
 * declarable name must match.
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
 * Names the evaluator handles before any user lookup and that
 * therefore cannot appear as a declarable group, an MCP id, or a
 * plugin id. Using one as an MCP id in `mcp.yml` is rejected by the
 * loader; declaring it in `PluginTool.groups` is rejected by the
 * plugin tool registry.
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
 * with a tool key — the DSL's bareword classifier uses that to tell
 * groups and tool patterns apart structurally.
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
            `tool group name "${name}" is not a valid DSL identifier (must match ${IDENT_PATTERN})`,
        );
    }
    if (RESERVED_GROUP_NAMES.has(name)) {
        throw new Error(
            `tool group name "${name}" is reserved by the DSL (${[...RESERVED_GROUP_NAMES].join(", ")})`,
        );
    }
}

/**
 * Replace every character outside `[a-zA-Z0-9_]` with `_`. Used to
 * build agent-facing tool keys (`${id}_${name}`) safe for every
 * model's function-call grammar — several open-source models (GLM
 * 5.1, some Qwen variants) silently drop tool calls when names
 * contain hyphens, which is why the MCP layer started folding them.
 * The plugin-tools layer reuses the same fold for consistency.
 */
export function sanitizeToolKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_]/g, "_");
}
