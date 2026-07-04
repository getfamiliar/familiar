import {
    ALL_GROUP_NAME,
    IDENT_PATTERN,
    NONE_GROUP_NAME,
    toolPatternMatches,
} from "@getfamiliar/shared";

/**
 * Per-handler tool resolution. A handler's `tools:` frontmatter is a
 * list of entries — supplied as a comma-separated string or a YAML
 * list — where each entry is one of:
 *
 * - an **explicit tool name** (`send_chat`, `fetch_fetch`),
 * - a **tool-name glob** (`atlassian_*`, `fs_*`), or
 * - a **group name** (`all`, `mcp`, `none`, curated groups like
 *   `core` / `fs` / `reflection`, plus one auto-group per MCP id and
 *   per plugin id).
 *
 * Entries are resolved independently and unioned — there are no
 * operators, no precedence, and no parentheses.
 *
 * **One atom shape for both groups and tool patterns.** Each entry is
 * classified by regex:
 *
 * - matches {@link IDENT_PATTERN} (`^[a-z][a-z0-9]*$` — lowercase
 *   alnum, leading letter, no `_`, no `*`) → **group**.
 * - anything else → **tool pattern** matched against the pool's
 *   namespaced keys with `*` as a glob wildcard.
 *
 * Tool keys always have the form `${id}_${name}` and contain at least
 * one underscore, so an alnum-only lowercase entry can never match a
 * tool key — it must be a group reference.
 *
 * Groups handled directly by the resolver before any `builtins`
 * lookup:
 *
 * - `all`  — every key in the available pool.
 * - `none` — empty set. Lets a child handler override its parent's
 *   `tools:` to nothing under the replace-merge rule.
 *
 * Curated names like `core`, `fs`, `reflection` are not handled here —
 * they emerge from the union of every tool (built-in container tool,
 * host-side core tool, or plugin tool) whose declared `groups` lists
 * the name. The caller threads those unions, the per-MCP-id and
 * per-plugin-id auto-groups, and `mcp` into the `builtins` map so a
 * single resolver path serves every group. The three reserved names
 * (`all`, `mcp`, `none`) are rejected by the `mcp.yml` linter and the
 * plugin tool registry so they can never collide there.
 */

export {
    ALL_GROUP_NAME,
    IDENT_PATTERN,
    MCP_GROUP_NAME,
    NONE_GROUP_NAME,
    RESERVED_GROUP_NAMES,
} from "@getfamiliar/shared";

/**
 * Resolve a handler's `tools:` entries against a snapshot of available
 * tool keys plus the per-call `builtins` group map. Each entry is
 * resolved independently and the results are unioned.
 *
 * @param entries Normalized `tools:` entries — already split from the
 *   comma string / YAML list, trimmed, and non-empty.
 * @param available Every tool key the agentrun currently exposes —
 *   system tools plus namespaced MCP / plugin tool keys, unioned.
 * @param builtins Per-call sets for the named groups — `mcp`, every
 *   curated group, and one entry per MCP id / plugin id. `all` and
 *   `none` are computed from `available` directly and need no entry.
 * @returns The set of available tool keys the handler may use.
 * @throws On a group name that is neither `all` / `none` nor present
 *   in `builtins`.
 */
export function resolveTools(
    entries: readonly string[],
    available: ReadonlySet<string>,
    builtins: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
    const out = new Set<string>();
    for (const entry of entries) {
        if (IDENT_PATTERN.test(entry)) {
            if (entry === ALL_GROUP_NAME) {
                for (const key of available) {
                    out.add(key);
                }
                continue;
            }
            if (entry === NONE_GROUP_NAME) {
                continue;
            }
            const group = builtins.get(entry);
            if (group === undefined) {
                throw new Error(`unknown group: ${entry}`);
            }
            for (const key of group) {
                out.add(key);
            }
            continue;
        }
        for (const key of matchTools(entry, available)) {
            out.add(key);
        }
    }
    return out;
}

/**
 * Glob-match a tool pattern against every available key, returning
 * the matches. Patterns without `*` are exact-match; `*` is a
 * wildcard for any character sequence (including `_`, since the
 * keys themselves contain `_`). A pattern that matches nothing
 * contributes nothing — no error. Per-key semantics come from the
 * shared {@link toolPatternMatches}.
 */
export function matchTools(pattern: string, available: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    if (!pattern.includes("*")) {
        if (available.has(pattern)) {
            out.add(pattern);
        }
        return out;
    }
    for (const key of available) {
        if (toolPatternMatches(pattern, key)) {
            out.add(key);
        }
    }
    return out;
}
