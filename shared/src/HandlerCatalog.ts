import { promises as fs } from "node:fs";
import path from "node:path";
import { matchesAnyGlob } from "./PathGlob.js";

/**
 * One handler entry surfaced by {@link HandlerCatalog.list}.
 *
 * Encodes the same notion as the container's `HandlerFile`: a topic
 * (one or more `:`-separated segments) plus a basename. `slashPath`
 * is the user-facing form the cli-chat prompt accepts as a direct
 * handler call (e.g. `/grocery/fruits/order`).
 */
export interface HandlerPath {
    /** Colon-separated topic, e.g. `chat:telegram`. */
    readonly topic: string;
    /** Handler basename without `.md`, e.g. `index`, `analyze`. */
    readonly handler: string;
    /** Absolute path on disk of the handler file. */
    readonly absolutePath: string;
    /** Workspace-relative posix path, e.g. `chat/telegram/index.md`. */
    readonly relativePath: string;
    /** User-facing slash form, e.g. `/chat/telegram/index`. */
    readonly slashPath: string;
}

/**
 * Workspace files at the very top level that are not handlers and
 * must be filtered out of {@link HandlerCatalog.list}. These are the
 * documents read by `buildSystemPrompt` rather than executed as
 * handlers (see `CLAUDE.md` — markdown layers / global context).
 */
const RESERVED_ROOT_FILES = new Set(["SOUL.md", "CONTEXT.md", "ENVIRONMENT.md"]);

/**
 * Workspace subtrees that contain markdown but never handlers.
 * `skills/<name>/SKILL.md` is a shared recipe loaded via `fs_read`,
 * not an agent entry point.
 */
const RESERVED_TOP_DIRS = new Set(["skills"]);

/**
 * Read-only view over the `workspace/` directory's handler files.
 *
 * Mirrors the resolution semantics implemented by
 * `container/src/HandlerFile.ts` so host-side code (CLI, cron
 * scheduler introspection, tab-completion) can answer "does this
 * handler exist?" and "list every handler" without depending on
 * container internals or reimplementing the topic-walk inheritance.
 *
 * The catalog is stateless on the disk — every method re-scans —
 * so live workspace edits are reflected without a daemon restart.
 * At REPL frequencies this is cheap; if a hot path later needs
 * caching it can wrap an instance.
 */
export class HandlerCatalog {
    private readonly workspaceDir: string;
    private readonly writablePathGlobs: readonly string[];

    /**
     * @param workspaceDir Absolute path of the `workspace/` directory.
     * @param writablePathGlobs `core.writablePaths` globs (e.g. `wiki/**`).
     *   Files under these are writable by non-privileged runs and are
     *   therefore never handlers — they are excluded from {@link list}
     *   and {@link resolve} so they are never proposed or resolved as a
     *   handler. Mirrors the container's `HandlerFile.load` guard.
     */
    constructor(workspaceDir: string, writablePathGlobs: readonly string[] = []) {
        this.workspaceDir = workspaceDir;
        this.writablePathGlobs = writablePathGlobs;
    }

    /**
     * Walk `workspace/` and return one {@link HandlerPath} per
     * candidate handler file. Excludes the global-context files at
     * the workspace root (`SOUL.md`, `CONTEXT.md`, `ENVIRONMENT.md`)
     * and the `skills/` subtree. Every other `.md` file under a topic
     * directory is included, even if it's a knowledge file (e.g.
     * `people/anna.md`) — `HandlerCatalog` does not police what is or
     * isn't a "proper" handler; that's a handler-loading concern.
     *
     * Sorted by `slashPath` for stable display ordering in
     * tab-completion. Returns an empty array when the workspace
     * directory does not exist.
     */
    async list(): Promise<readonly HandlerPath[]> {
        const exists = await directoryExists(this.workspaceDir);
        if (!exists) {
            return [];
        }
        const results: HandlerPath[] = [];
        await walkMarkdown(
            this.workspaceDir,
            [],
            results,
            this.workspaceDir,
            this.writablePathGlobs,
        );
        results.sort((a, b) => a.slashPath.localeCompare(b.slashPath));
        return results;
    }

    /**
     * Resolve a handler call: given a topic (e.g. `chat:telegram`)
     * and a basename (e.g. `index`), return the absolute path of the
     * deepest existing handler file, mirroring the container's
     * inheritance walk.
     *
     * For topic `a:b:c` and basename `x` the resolution tries, in
     * order: `a/b/c/x.md`, `a/b/x.md`, `a/x.md`. Returns the first
     * existing path or `null` if none exist. The deepest existing
     * file is what `HandlerFile.load` would treat as the leaf — for
     * cli-chat existence checks, that's exactly the question we
     * want answered.
     */
    async resolve(topic: string, handler: string): Promise<string | null> {
        const segments = topic.split(":");
        for (let depth = segments.length; depth >= 1; depth--) {
            const rel = path.join(...segments.slice(0, depth), `${handler}.md`);
            const relPosix = rel.split(path.sep).join("/");
            const absolute = path.join(this.workspaceDir, rel);
            if (await fileExists(absolute)) {
                // A file under `core.writablePaths` is never a handler, even
                // when it exists — mirror the container's `HandlerFile.load`
                // guard so host-side callers agree it does not resolve.
                if (matchesAnyGlob(this.writablePathGlobs, relPosix)) {
                    return null;
                }
                return absolute;
            }
        }
        return null;
    }
}

/**
 * Recursively walk `dir`, accumulating one {@link HandlerPath} per
 * `.md` file. `segments` tracks the topic path from the workspace
 * root; an empty array means we're at the root, where reserved files
 * are skipped.
 */
async function walkMarkdown(
    dir: string,
    segments: readonly string[],
    out: HandlerPath[],
    workspaceDir: string,
    writablePathGlobs: readonly string[],
): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (segments.length === 0 && RESERVED_TOP_DIRS.has(entry.name)) {
                continue;
            }
            await walkMarkdown(
                path.join(dir, entry.name),
                [...segments, entry.name],
                out,
                workspaceDir,
                writablePathGlobs,
            );
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) {
            continue;
        }
        if (segments.length === 0 && RESERVED_ROOT_FILES.has(entry.name)) {
            continue;
        }
        if (segments.length === 0) {
            // Stray `.md` at the workspace root with no topic folder —
            // not a handler. Skip silently rather than reporting an
            // empty topic.
            continue;
        }
        const handlerBase = entry.name.slice(0, -".md".length);
        const topic = segments.join(":");
        const absolutePath = path.join(dir, entry.name);
        const relativePath = path.relative(workspaceDir, absolutePath).split(path.sep).join("/");
        // Files under `core.writablePaths` (e.g. `wiki/**`) are writable by
        // non-privileged runs and are never handlers — never propose them.
        if (matchesAnyGlob(writablePathGlobs, relativePath)) {
            continue;
        }
        const slashPath = `/${[...segments, handlerBase].join("/")}`;
        out.push({ topic, handler: handlerBase, absolutePath, relativePath, slashPath });
    }
}

async function fileExists(absolute: string): Promise<boolean> {
    try {
        const stat = await fs.stat(absolute);
        return stat.isFile();
    } catch {
        return false;
    }
}

async function directoryExists(absolute: string): Promise<boolean> {
    try {
        const stat = await fs.stat(absolute);
        return stat.isDirectory();
    } catch {
        return false;
    }
}
