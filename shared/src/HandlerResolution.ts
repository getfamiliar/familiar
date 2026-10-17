import { TOPIC_PATTERN } from "./Schema.js";

const TOPIC_REGEXP = new RegExp(TOPIC_PATTERN);

/** File name of the folder form of a handler (`a/b/c/index.md`). */
const INDEX_FILE = "index.md";

/**
 * Outcome of {@link resolveHandlerPath}: the one handler file a topic
 * resolves to.
 */
export interface HandlerResolution {
    /** Workspace-relative posix path of the winning file, e.g. `mail/new/ms365.md`. */
    readonly relativePath: string;
    /**
     * Workspace-relative path of the twin that lost against
     * {@link relativePath} on the same level (`mail/new/ms365/index.md`
     * when `mail/new/ms365.md` also exists), or `null` when the level
     * held only one file. Only one of the two forms is allowed; callers
     * warn when this is set.
     */
    readonly shadowedPath: string | null;
}

/**
 * Options for {@link handlerCandidateLevels} / {@link resolveHandlerPath}.
 */
export interface HandlerResolutionOptions {
    /**
     * `true` ⇒ only the topic's own level is tried (cron, subagents,
     * scheduled wake-ups, addressed emissions). `false` ⇒ the resolver
     * walks up the topic chain (`a:b:c → a:b → a`), which is what
     * world events get.
     */
    readonly isExactTopic: boolean;
}

/**
 * Build the candidate handler files for a topic, one entry per topic
 * level (most specific first). Each level lists its candidates in
 * precedence order: the file form `a/b/c.md` before the folder form
 * `a/b/c/index.md`. A single-segment topic `a` has only `a/index.md`
 * — workspace-root files are never handlers.
 *
 * For topic `mail:new:ms365` without `isExactTopic`:
 *
 *   1. `mail/new/ms365.md`, `mail/new/ms365/index.md`
 *   2. `mail/new.md`, `mail/new/index.md`
 *   3. `mail/index.md`
 *
 * @param topic Colon-separated topic, e.g. `mail:new:ms365`.
 * @param options See {@link HandlerResolutionOptions}.
 * @returns The candidate levels, most specific first.
 */
export function handlerCandidateLevels(
    topic: string,
    options: HandlerResolutionOptions,
): readonly (readonly string[])[] {
    const segments = topic.split(":");
    const shallowestDepth = options.isExactTopic ? segments.length : 1;
    const levels: string[][] = [];
    for (let depth = segments.length; depth >= shallowestDepth; depth--) {
        const folder = segments.slice(0, depth).join("/");
        const level = depth === 1 ? [] : [`${folder}.md`];
        level.push(`${folder}/${INDEX_FILE}`);
        levels.push(level);
    }
    return levels;
}

/**
 * Resolve a topic to the single handler file that runs for it. The
 * first level of {@link handlerCandidateLevels} holding any existing
 * file wins; within a level the file form beats the folder form and
 * the loser is reported as {@link HandlerResolution.shadowedPath}.
 * Nothing is merged — exactly one file is the handler.
 *
 * @param topic Colon-separated topic, e.g. `mail:new:ms365`.
 * @param options See {@link HandlerResolutionOptions}.
 * @param isFile Existence probe for a workspace-relative path.
 * @returns The resolution, or `null` when no candidate exists.
 */
export function resolveHandlerPath(
    topic: string,
    options: HandlerResolutionOptions,
    isFile: (relativePath: string) => boolean,
): HandlerResolution | null {
    for (const level of handlerCandidateLevels(topic, options)) {
        const existing = level.filter((candidate) => isFile(candidate));
        if (existing.length > 0) {
            return { relativePath: existing[0], shadowedPath: existing[1] ?? null };
        }
    }
    return null;
}

/**
 * Derive the topic a handler file answers to. The inverse of
 * {@link handlerCandidateLevels}' own level:
 *
 * - `mail/important/digest.md` → `mail:important:digest`
 * - `mail/new/index.md` → `mail:new`
 * - `mail/index.md` → `mail`
 *
 * @param relativePath Workspace-relative posix path ending in `.md`.
 * @returns The topic, or `null` for workspace-root files, non-`.md`
 *   files and paths whose segments don't form a valid topic (e.g. a
 *   file name containing a dot or a space).
 */
export function topicFromHandlerPath(relativePath: string): string | null {
    if (!relativePath.endsWith(".md")) {
        return null;
    }
    const segments = relativePath.split("/");
    if (segments.length < 2) {
        return null;
    }
    const fileName = segments[segments.length - 1];
    const folders = segments.slice(0, -1);
    const topicSegments =
        fileName === INDEX_FILE ? folders : [...folders, fileName.slice(0, -".md".length)];
    const topic = topicSegments.join(":");
    return TOPIC_REGEXP.test(topic) ? topic : null;
}

/**
 * The other form of the same handler: `a/b/c.md` ↔ `a/b/c/index.md`.
 * Only one of the two may exist; seeding and the cron scheduler use
 * this to detect the conflict.
 *
 * @param relativePath Workspace-relative posix path ending in `.md`.
 * @returns The twin's path, or `null` when the twin would be a
 *   workspace-root file (`a/index.md` ↔ `a.md`) or the path is a root
 *   file / not markdown.
 */
export function twinHandlerPath(relativePath: string): string | null {
    if (!relativePath.endsWith(".md")) {
        return null;
    }
    const segments = relativePath.split("/");
    if (segments.length < 2) {
        return null;
    }
    const fileName = segments[segments.length - 1];
    if (fileName === INDEX_FILE) {
        return segments.length < 3 ? null : `${segments.slice(0, -1).join("/")}.md`;
    }
    return `${relativePath.slice(0, -".md".length)}/${INDEX_FILE}`;
}
