/**
 * Public types describing the workspace-file surface plugins can observe
 * via `ctx.workspace.onFileUpdate(...)`. The concrete watcher lives in the
 * host (`host/src/workspace/WorkspaceWatcher.ts`); plugins only ever see
 * this contract.
 */

/**
 * Filter describing which workspace files a subscriber cares about.
 *
 * All fields are optional and combined with AND semantics. An empty
 * filter matches every `.md` file under the workspace.
 */
export interface WorkspaceFileFilter {
    /**
     * Frontmatter key → search expression. The file matches iff every
     * key listed here is present in the file's YAML frontmatter AND
     * the stringified value matches the expression.
     *
     * The expression is a substring matcher with `*` as the any-chars
     * wildcard. `"*"` alone means "key present with any value". `"foo"`
     * means "value contains the substring `foo`". `"foo*bar"` means
     * "value contains `foo` somewhere, then `bar` later".
     */
    readonly frontmatter?: Readonly<Record<string, string>>;
    /**
     * Optional substring-with-`*` glob applied to the workspace-relative
     * path. Same wildcard grammar as the frontmatter values.
     */
    readonly pathGlob?: string;
}

/**
 * One change notification dispatched to a subscriber. `kind` reports the
 * transition from the subscriber's point of view: `"added"` on first
 * match (creation or a frontmatter edit that brings the file in scope),
 * `"changed"` for content edits while still matching, and `"removed"`
 * on the reverse transition (deletion or a frontmatter edit that takes
 * the file out of scope — the file may still exist on disk).
 */
export interface WorkspaceFileEvent {
    readonly kind: "added" | "changed" | "removed";
    /** Path relative to the workspace root, POSIX separators. */
    readonly relativePath: string;
    /** Absolute path on disk. */
    readonly absolutePath: string;
}

/**
 * The `ctx.workspace` surface plugins use. Today exposes only file-change
 * subscriptions; future hooks (snapshot reads, frontmatter queries) land
 * here as plugins need them.
 */
export interface WorkspaceWatcherApi {
    /**
     * Subscribe to file changes matching the filter. Returns the
     * unsubscribe function. The callback fires once per transition (no
     * initial replay of existing matches); plugins that need a baseline
     * snapshot should do their own scan in `start()`.
     */
    onFileUpdate(
        filter: WorkspaceFileFilter,
        callback: (event: WorkspaceFileEvent) => void,
    ): () => void;
}
