/**
 * Substring-with-`*` glob matcher shared across the platform: the
 * workspace watcher's `WorkspaceFileFilter.pathGlob`, the memory
 * indexer's exclude list, the memory context provider's embed
 * eligibility check, and the container fs tools' `core.writablePaths`
 * allowlist all speak this same grammar.
 *
 * `*` stands for "any characters", everything else is literal, no
 * anchoring. `wiki/**` collapses to `wiki/.*` (matches anything
 * containing `wiki/<rest>`), which is the intended ergonomics here —
 * workspace paths never embed `wiki/` in the middle, so the lack of
 * anchoring doesn't cause false positives in practice. Always match
 * against the workspace-relative POSIX path so a glob means the same
 * thing at every call site.
 */
export function matchesGlob(pattern: string, value: string): boolean {
    if (pattern === "*" || pattern === "**") {
        return true;
    }
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(escaped).test(value);
}

/** Convenience: true iff `value` matches at least one of the patterns. */
export function matchesAnyGlob(patterns: readonly string[], value: string): boolean {
    for (const pattern of patterns) {
        if (matchesGlob(pattern, value)) {
            return true;
        }
    }
    return false;
}
