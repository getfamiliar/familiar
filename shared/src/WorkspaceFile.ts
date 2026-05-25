/**
 * Public types describing the workspace-file surface plugins observe via
 * `ctx.workspace.*`. The concrete watcher lives in the host
 * (`host/src/workspace/WorkspaceWatcher.ts`); host and plugins share the
 * same `WorkspaceFile` shape — no projection layer.
 */

/**
 * Filter describing which workspace files a subscriber cares about.
 *
 * All fields are optional and combined with AND semantics. An empty
 * filter matches every file in scope (the watcher's scope is markdown
 * only — see {@link WorkspaceWatcherApi}).
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
 * A workspace file observed by the watcher.
 *
 * Returned by {@link WorkspaceWatcherApi.listMarkdownFiles} (with `kind`
 * omitted) and dispatched to {@link WorkspaceWatcherApi.onMarkdownFileUpdate}
 * callbacks (with `kind` set to the transition that triggered the
 * notification).
 *
 * `removed` may be synthetic: a file whose frontmatter changed such
 * that it no longer matches a subscription's filter is reported as
 * `removed` even though the file still exists on disk. The file is
 * gone *from the subscriber's point of view*, which is the only thing
 * the consumer can act on.
 */
export interface WorkspaceFile {
    /** Path relative to the workspace root, POSIX separators. */
    readonly relativePath: string;
    /** Absolute path on disk. */
    readonly absolutePath: string;
    /**
     * Transition kind. Always set on `onMarkdownFileUpdate` callbacks
     * (`"added"` on first match — creation or a frontmatter edit that
     * brings the file into scope; `"changed"` for content edits while
     * still in scope; `"removed"` on the reverse transition). Always
     * omitted on `listMarkdownFiles` results.
     */
    readonly kind?: "added" | "changed" | "removed";
}

/**
 * The `ctx.workspace` surface plugins use to observe workspace files.
 *
 * **Scope: markdown only.** Only `.md` files under the workspace root
 * are tracked. Both methods below ignore every other extension; an
 * empty filter still only matches `.md` files. (The method names
 * spell this out — `listMarkdownFiles`, `onMarkdownFileUpdate` — so
 * the scope is impossible to miss at the call site.)
 *
 * The intended pattern is snapshot-then-diff: call
 * {@link listMarkdownFiles} once for the baseline, then
 * {@link onMarkdownFileUpdate} for live transitions. Both calls take
 * the same {@link WorkspaceFileFilter}; together they give a plugin a
 * complete view (baseline + live transitions) without the watcher
 * having to re-announce pre-existing files on subscription.
 *
 * Example:
 *
 *     const snapshot = await ctx.workspace.listMarkdownFiles(filter);
 *     for (const file of snapshot) { ...seed... }
 *     const unsub = ctx.workspace.onMarkdownFileUpdate(filter, handleDelta);
 *
 * Only available inside the daemon — CLI subcommands run without a
 * live watcher, so both methods throw with an explicit message in
 * that mode.
 */
export interface WorkspaceWatcherApi {
    /**
     * Snapshot of every workspace `.md` file currently matching the
     * filter. Reads from the watcher's in-memory cache (no fresh disk
     * scan); chokidar keeps that cache continuously in sync with disk.
     * Returned entries have `kind` omitted. Pair with
     * {@link onMarkdownFileUpdate} — see the interface-level doc.
     */
    listMarkdownFiles(filter: WorkspaceFileFilter): Promise<readonly WorkspaceFile[]>;

    /**
     * Subscribe to `.md` file transitions matching the filter. The
     * callback fires per transition with `kind` always set. Pre-existing
     * matches at subscription time are **not** replayed — call
     * {@link listMarkdownFiles} for the baseline.
     *
     * Returns the unsubscribe handle.
     */
    onMarkdownFileUpdate(
        filter: WorkspaceFileFilter,
        callback: (file: WorkspaceFile) => void,
    ): () => void;
}
