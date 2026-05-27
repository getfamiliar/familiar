/**
 * Root-anchored `*`-glob matcher shared across the platform: the memory
 * indexer's exclude list, the memory context provider's embed
 * eligibility check, the container fs tools' `core.writablePaths`
 * allowlist, and the handler-resolution guards all speak this same
 * grammar.
 *
 * `*` stands for "any characters", everything else is literal. The
 * pattern is **anchored at the workspace root** (the leading `^`): it
 * matches from the start of the workspace-relative POSIX path, not as a
 * floating substring. So `wiki/**` collapses to `^wiki/.*` and matches
 * `wiki/<rest>` only — never `notwiki/secret.md`, which the old
 * unanchored grammar would have falsely matched. A trailing `*` (as in
 * `wiki/**`) keeps the tail open, so the end is intentionally not
 * anchored. Always match against the workspace-relative POSIX path so a
 * glob means the same thing at every call site.
 */
export function matchesGlob(pattern: string, value: string): boolean {
    if (pattern === "*" || pattern === "**") {
        return true;
    }
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}`).test(value);
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
