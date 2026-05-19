import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Logger } from "@getfamiliar/shared";
import chokidar, { type FSWatcher } from "chokidar";
import { parse as parseYaml } from "yaml";

/**
 * Filter describing which workspace files a consumer cares about.
 *
 * All fields are optional and combined with AND semantics. An empty
 * filter matches every `.md` file under the workspace.
 */
export interface FileFilter {
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
 * Returned both by {@link WorkspaceWatcher.listFiles} (snapshot, no
 * `type`) and by {@link WorkspaceWatcher.onFileUpdate} subscriptions
 * (`type` set to the change kind that triggered the notification).
 *
 * `removed` may be synthetic: a file whose frontmatter changed such
 * that it no longer matches a subscription's filter is reported as
 * `removed` even though the file still exists on disk. The file is
 * gone *from the subscriber's point of view*, which is the only thing
 * the consumer can act on.
 */
export interface WorkspaceFile {
    /** Path relative to the watched workspace root (POSIX separators). */
    readonly relativePath: string;
    /** Absolute path on disk. */
    readonly absolutePath: string;
    /** Only set on update notifications; omitted by listFiles. */
    readonly type?: "added" | "changed" | "removed";
}

/** Internal cache entry per known workspace file. */
interface FileEntry {
    readonly relativePath: string;
    readonly absolutePath: string;
    readonly frontmatter: Readonly<Record<string, string>>;
}

interface Subscription {
    readonly filter: FileFilter;
    readonly callback: (file: WorkspaceFile) => void;
    readonly matching: Set<string>;
}

/**
 * Generalized file watcher over the workspace directory.
 *
 * Consumers express interest with a {@link FileFilter} and receive
 * either a one-shot snapshot ({@link listFiles}) or a long-lived
 * stream of changes ({@link onFileUpdate}). The watcher hides chokidar
 * and the frontmatter-parse caching behind both methods so consumers
 * never re-read or re-parse the same file.
 *
 * Only `.md` files are tracked. Other features can widen this later;
 * cron and the foreseeable next consumers are markdown-only.
 */
export class WorkspaceWatcher {
    private readonly workspaceDir: string;
    private readonly log: Logger;
    private watcher: FSWatcher | undefined;
    private readonly files = new Map<string, FileEntry>();
    private readonly subscriptions = new Set<Subscription>();
    private ready: Promise<void> | undefined;

    constructor(opts: { workspaceDir: string; log: Logger }) {
        this.workspaceDir = opts.workspaceDir;
        this.log = opts.log;
    }

    /**
     * Begin watching the workspace. Resolves once the initial scan has
     * settled so that {@link listFiles} reflects a complete snapshot
     * immediately afterwards. Safe to call once; double-start throws.
     */
    async start(): Promise<void> {
        if (this.watcher) {
            throw new Error("WorkspaceWatcher already started");
        }
        const watcher = chokidar.watch(this.workspaceDir, {
            ignoreInitial: false,
            persistent: true,
            // Wait for writes to settle before firing — editors that
            // truncate-then-write would otherwise emit a `change` on
            // an empty file and again on the final content.
            awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
            // Hidden files (dotfiles) are excluded; the workspace is
            // markdown only, and `.git`, `.DS_Store`, etc. add noise.
            ignored: (path: string) => {
                const base = path.split(sep).pop() ?? path;
                return base.startsWith(".");
            },
        });
        this.watcher = watcher;
        watcher.on("add", (absolute: string) => {
            if (!isMarkdownPath(absolute)) {
                return;
            }
            this.handleAddOrChange(absolute);
        });
        watcher.on("change", (absolute: string) => {
            if (!isMarkdownPath(absolute)) {
                return;
            }
            this.handleAddOrChange(absolute);
        });
        watcher.on("unlink", (absolute: string) => {
            if (!isMarkdownPath(absolute)) {
                return;
            }
            this.handleUnlink(absolute);
        });
        watcher.on("error", (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.log.error({ err: message }, "workspace watcher error");
        });
        this.ready = new Promise<void>((resolve) => {
            watcher.once("ready", () => resolve());
        });
        await this.ready;
    }

    /** Stop the watcher and release filesystem handles. Idempotent. */
    async stop(): Promise<void> {
        if (!this.watcher) {
            return;
        }
        const w = this.watcher;
        this.watcher = undefined;
        this.subscriptions.clear();
        this.files.clear();
        await w.close();
    }

    /**
     * Return every currently-known file matching the filter. Awaits the
     * initial scan if it hasn't settled yet, so a caller invoked early
     * (e.g. from another component's `start`) still sees a complete
     * snapshot rather than a partial one.
     */
    async listFiles(filter: FileFilter): Promise<readonly WorkspaceFile[]> {
        if (!this.watcher) {
            throw new Error("WorkspaceWatcher.listFiles called before start()");
        }
        if (this.ready) {
            await this.ready;
        }
        const out: WorkspaceFile[] = [];
        for (const entry of this.files.values()) {
            if (matchesFilter(entry, filter)) {
                out.push({
                    relativePath: entry.relativePath,
                    absolutePath: entry.absolutePath,
                });
            }
        }
        return out;
    }

    /**
     * Subscribe to changes affecting files that match the filter. The
     * callback fires with `type: "added"` on the *transition* from
     * not-matching to matching (creation, or a frontmatter edit that
     * brings the file into scope), `type: "changed"` for content
     * changes while still matching, and `type: "removed"` on the
     * reverse transition (deletion, or a frontmatter edit that takes
     * the file out of scope).
     *
     * The returned function is the unsubscribe handle.
     */
    onFileUpdate(filter: FileFilter, callback: (file: WorkspaceFile) => void): () => void {
        const sub: Subscription = {
            filter,
            callback,
            matching: new Set<string>(),
        };
        for (const entry of this.files.values()) {
            if (matchesFilter(entry, filter)) {
                sub.matching.add(entry.relativePath);
            }
        }
        this.subscriptions.add(sub);
        return () => {
            this.subscriptions.delete(sub);
        };
    }

    /** Re-read, re-parse, update the cache, and dispatch to subscriptions. */
    private handleAddOrChange(absolutePath: string): void {
        const relativePath = toRelative(this.workspaceDir, absolutePath);
        let frontmatter: Record<string, string>;
        try {
            frontmatter = readFrontmatter(absolutePath);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(
                { path: relativePath, err: message },
                "failed to parse workspace file frontmatter; treating as empty",
            );
            frontmatter = {};
        }
        const entry: FileEntry = { relativePath, absolutePath, frontmatter };
        this.files.set(relativePath, entry);
        for (const sub of this.subscriptions) {
            const wasMatching = sub.matching.has(relativePath);
            const isMatching = matchesFilter(entry, sub.filter);
            if (!wasMatching && isMatching) {
                sub.matching.add(relativePath);
                this.dispatch(sub, entry, "added");
            } else if (wasMatching && isMatching) {
                this.dispatch(sub, entry, "changed");
            } else if (wasMatching && !isMatching) {
                sub.matching.delete(relativePath);
                this.dispatch(sub, entry, "removed");
            }
        }
    }

    /** Drop the cache entry and notify any subscriptions that were tracking it. */
    private handleUnlink(absolutePath: string): void {
        const relativePath = toRelative(this.workspaceDir, absolutePath);
        const entry = this.files.get(relativePath);
        this.files.delete(relativePath);
        for (const sub of this.subscriptions) {
            if (!sub.matching.has(relativePath)) {
                continue;
            }
            sub.matching.delete(relativePath);
            const synthetic: FileEntry = entry ?? {
                relativePath,
                absolutePath,
                frontmatter: {},
            };
            this.dispatch(sub, synthetic, "removed");
        }
    }

    private dispatch(
        sub: Subscription,
        entry: FileEntry,
        type: "added" | "changed" | "removed",
    ): void {
        try {
            sub.callback({
                relativePath: entry.relativePath,
                absolutePath: entry.absolutePath,
                type,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.error({ path: entry.relativePath, err: message }, "subscriber threw");
        }
    }
}

/**
 * One-shot workspace scan that mirrors what {@link WorkspaceWatcher}
 * does on startup, without spinning up chokidar. Used by CLI commands
 * (e.g. `cli.sh cron list`) that need a snapshot without a live daemon.
 *
 * Returns every `.md` file under `workspaceDir` whose frontmatter
 * satisfies the filter. Hidden files and directories are skipped.
 */
export async function scanWorkspace(
    workspaceDir: string,
    filter: FileFilter,
): Promise<readonly WorkspaceFile[]> {
    const out: WorkspaceFile[] = [];
    await walk(workspaceDir, async (absolutePath) => {
        if (!isMarkdownPath(absolutePath)) {
            return;
        }
        const relativePath = toRelative(workspaceDir, absolutePath);
        let frontmatter: Record<string, string>;
        try {
            frontmatter = readFrontmatter(absolutePath);
        } catch {
            frontmatter = {};
        }
        const entry: FileEntry = { relativePath, absolutePath, frontmatter };
        if (matchesFilter(entry, filter)) {
            out.push({ relativePath, absolutePath });
        }
    });
    return out;
}

async function walk(dir: string, visit: (absolutePath: string) => Promise<void>): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const ent of entries) {
        if (ent.name.startsWith(".")) {
            continue;
        }
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
            await walk(full, visit);
        } else if (ent.isFile()) {
            await visit(full);
        } else if (ent.isSymbolicLink()) {
            const target = await stat(full).catch(() => undefined);
            if (target?.isFile()) {
                await visit(full);
            }
        }
    }
}

/**
 * Test whether a file entry matches a filter. Exported for unit tests;
 * the production callers are `listFiles` and the subscription dispatch.
 */
export function matchesFilter(entry: FileEntry, filter: FileFilter): boolean {
    if (filter.pathGlob !== undefined && !matchSearchExpr(filter.pathGlob, entry.relativePath)) {
        return false;
    }
    if (filter.frontmatter) {
        for (const [key, expr] of Object.entries(filter.frontmatter)) {
            const value = entry.frontmatter[key];
            if (value === undefined) {
                return false;
            }
            if (!matchSearchExpr(expr, value)) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Substring-with-`*` matcher. The expression is split on `*`; each
 * resulting chunk must appear in `value` in order. `"*"` alone yields
 * two empty chunks and trivially matches any non-empty `value`.
 *
 * Exported for unit tests.
 */
export function matchSearchExpr(expr: string, value: string): boolean {
    const parts = expr.split("*");
    let cursor = 0;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.length === 0) {
            continue;
        }
        const found = value.indexOf(part, cursor);
        if (found < 0) {
            return false;
        }
        // First part must anchor to the start unless prefixed by `*`.
        if (i === 0 && found !== 0) {
            return false;
        }
        cursor = found + part.length;
    }
    // Last part must anchor to the end unless suffixed by `*`.
    const last = parts[parts.length - 1];
    if (last.length > 0 && cursor !== value.length) {
        return false;
    }
    return true;
}

/** Read a file's YAML frontmatter as a flat map of stringified values. */
function readFrontmatter(absolutePath: string): Record<string, string> {
    const source = readFileSync(absolutePath, "utf8");
    const trimmed = source.trimStart();
    const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n?/);
    if (!match) {
        return {};
    }
    const parsed = parseYaml(match[1]);
    if (parsed === null || parsed === undefined) {
        return {};
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v === undefined || v === null) {
            continue;
        }
        out[k] = typeof v === "string" ? v : String(v);
    }
    return out;
}

function isMarkdownPath(path: string): boolean {
    return path.endsWith(".md");
}

function toRelative(root: string, absolute: string): string {
    const rel = relative(root, absolute);
    return sep === "/" ? rel : rel.split(sep).join("/");
}
