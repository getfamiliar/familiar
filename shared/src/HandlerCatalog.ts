import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import {
    type HandlerResolution,
    type HandlerResolutionOptions,
    resolveHandlerPath,
    topicFromHandlerPath,
    twinHandlerPath,
} from "./HandlerResolution.js";
import { matchesAnyGlob } from "./PathGlob.js";

/**
 * One handler entry surfaced by {@link HandlerCatalog.list}.
 *
 * The topic is the handler's whole address (`chat:telegram` for both
 * `chat/telegram.md` and `chat/telegram/index.md`). `slashPath` is the
 * user-facing form the cli-chat prompt accepts as a direct handler call
 * (e.g. `/grocery/fruits/order`).
 */
export interface HandlerPath {
    /** Colon-separated topic, e.g. `chat:telegram`. */
    readonly topic: string;
    /** Absolute path on disk of the handler file. */
    readonly absolutePath: string;
    /** Workspace-relative posix path, e.g. `chat/telegram.md`. */
    readonly relativePath: string;
    /** User-facing slash form of the topic, e.g. `/chat/telegram`. */
    readonly slashPath: string;
}

/** A {@link HandlerResolution} plus the winning file's absolute path. */
export interface ResolvedHandler extends HandlerResolution {
    /** Absolute path on disk of the winning handler file. */
    readonly absolutePath: string;
}

/**
 * Workspace subtrees excluded from {@link HandlerCatalog.list} (cli-chat
 * tab-completion), so `SKILL.md` recipes don't clutter the proposals.
 * This is a listing concern only: handlers that live next to a skill
 * (e.g. `skills/memory/save.md`, or a `skills/memory/dream.md` with a
 * `cron:` field) are deliberately loadable, resolvable and
 * cron-scheduled like any other handler.
 */
const RESERVED_TOP_DIRS = new Set(["skills"]);

/**
 * Read-only view over the `workspace/` directory's handler files.
 *
 * Shares the resolution rules of `container/src/HandlerFile.ts` (both
 * build on `HandlerResolution.ts`) so host-side code (CLI, cron
 * scheduler introspection, tab-completion) can answer "does this
 * handler exist?" and "list every handler" without depending on
 * container internals.
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
     * addressable handler file. Excludes every file at the workspace
     * root (`PROMPT.md`, `SOUL.md`, … — root files have no topic, so they
     * are never handlers), the `skills/` subtree, writable paths, file
     * names that don't form a valid topic, and a folder-form
     * `x/index.md` shadowed by its `x.md` twin. Every other `.md` file
     * under a topic directory is included, even if it's a knowledge file
     * (e.g. `people/anna.md`) — `HandlerCatalog` does not police what is
     * or isn't a "proper" handler; that's a handler-loading concern.
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
        const relativePaths: string[] = [];
        await walkMarkdown(this.workspaceDir, [], relativePaths);
        const present = new Set(relativePaths);
        const results: HandlerPath[] = [];
        for (const relativePath of relativePaths) {
            // Files under `core.writablePaths` (e.g. `wiki/**`) are writable by
            // non-privileged runs and are never handlers — never propose them.
            if (matchesAnyGlob(this.writablePathGlobs, relativePath)) {
                continue;
            }
            const topic = topicFromHandlerPath(relativePath);
            if (topic === null) {
                continue;
            }
            const twin = twinHandlerPath(relativePath);
            if (relativePath.endsWith("/index.md") && twin !== null && present.has(twin)) {
                continue;
            }
            results.push({
                topic,
                absolutePath: path.join(this.workspaceDir, relativePath),
                relativePath,
                slashPath: `/${topic.split(":").join("/")}`,
            });
        }
        results.sort((a, b) => a.slashPath.localeCompare(b.slashPath));
        return results;
    }

    /**
     * Resolve a topic to the one handler file that runs for it, with
     * the same rules as the container's `HandlerFile.load`: file form
     * `a/b/c.md` before folder form `a/b/c/index.md`, and — unless
     * `isExactTopic` — falling back up the topic chain.
     *
     * @param topic Colon-separated topic, e.g. `chat:telegram`.
     * @param options See {@link HandlerResolutionOptions}.
     * @returns The resolution, or `null` when nothing matches or the
     *   winning file lives under a writable path (the container refuses
     *   to run it, so it does not resolve).
     */
    async resolve(
        topic: string,
        options: HandlerResolutionOptions,
    ): Promise<ResolvedHandler | null> {
        const resolution = resolveHandlerPath(topic, options, (relativePath) =>
            isFileSync(path.join(this.workspaceDir, relativePath)),
        );
        if (
            resolution === null ||
            matchesAnyGlob(this.writablePathGlobs, resolution.relativePath)
        ) {
            return null;
        }
        return {
            ...resolution,
            absolutePath: path.join(this.workspaceDir, resolution.relativePath),
        };
    }
}

/**
 * Recursively walk `dir`, accumulating the workspace-relative posix
 * path of every `.md` file below a topic folder. `segments` tracks the
 * folder path from the workspace root; files at the root itself are
 * skipped (no topic, never a handler), and so is the reserved
 * `skills/` subtree.
 */
async function walkMarkdown(
    dir: string,
    segments: readonly string[],
    out: string[],
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
            await walkMarkdown(path.join(dir, entry.name), [...segments, entry.name], out);
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md") || segments.length === 0) {
            continue;
        }
        out.push([...segments, entry.name].join("/"));
    }
}

/**
 * Synchronous regular-file probe, used as the existence callback of
 * {@link resolveHandlerPath}.
 */
function isFileSync(absolute: string): boolean {
    try {
        return statSync(absolute).isFile();
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
