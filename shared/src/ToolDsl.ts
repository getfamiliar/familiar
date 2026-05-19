/**
 * Cross-cutting constants for the tools-DSL — the small expression
 * language used in handler markdown frontmatter (`tools:`) and in
 * `workspace/toolgroups/*.txt` files. The full parser/evaluator
 * lives in the container (`container/src/tools/ToolFilter.ts`); the
 * pieces re-exported here are the ones the host-side `mcp.yml`
 * linter also needs to enforce — namely, the set of group names
 * that the evaluator reserves for built-ins. An MCP id that
 * collides with one of those would be silently shadowed at
 * evaluation time, so the linter rejects it up front.
 */

/** Built-in group: every key in the available pool (system ∪ MCP). */
export const ALL_GROUP_NAME = "all";

/** Built-in group: just the system-tool keys for the current agentrun. */
export const SYSTEM_GROUP_NAME = "system";

/** Built-in group: just the MCP-tool keys for the current agentrun. */
export const MCP_GROUP_NAME = "mcp";

/** Built-in group: empty set — used to override a parent's `tools:`. */
export const NONE_GROUP_NAME = "none";

/**
 * Built-in group: host-side tools the core ships (`cal_*`,
 * eventually approval-gate prompts, etc.). Registered without a
 * plugin-id prefix, so a handler enables them via `tools: core`.
 */
export const CORE_GROUP_NAME = "core";

/**
 * Names the evaluator handles before any user lookup. Re-defining
 * one of these in `workspace/toolgroups/<name>.txt` is silently
 * shadowed; using one as an MCP id in `mcp.yml` is rejected by the
 * loader so the conflict surfaces at lint time.
 */
export const RESERVED_GROUP_NAMES: ReadonlySet<string> = new Set([
    ALL_GROUP_NAME,
    SYSTEM_GROUP_NAME,
    MCP_GROUP_NAME,
    NONE_GROUP_NAME,
    CORE_GROUP_NAME,
]);

/**
 * Pattern any group name — built-in, user-defined, or
 * MCP-id-derived auto-group — must match.
 *
 * Lowercase alphanumeric only, leading letter, no underscores and
 * no hyphens. The exclusion of `_` is load-bearing: tool keys are
 * always shaped `${id}_${name}` and contain at least one
 * underscore, so an underscore-free bareword can never collide
 * with a tool key — the DSL's bareword classifier uses that to
 * tell groups and tool patterns apart structurally.
 *
 * This is also why `mcp.yml` ids must match the same pattern
 * (enforced in `McpConfigLoader`): every id is auto-exposed as a
 * same-named group, and an id with a hyphen or underscore would
 * either break the `${id}_${name}` join or shadow the
 * tool-pattern shape.
 */
export const IDENT_PATTERN = /^[a-z][a-z0-9]*$/;

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
