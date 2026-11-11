import type { WikiIndex } from "./WikiIndex.js";
import { WIKI_FOLDER } from "./WikiIndex.js";

/** Most files one dedup group may hold. */
export const MAX_GROUP_SIZE = 5;

/** A stored pair counts as stale once a file's size changed by this fraction … */
const STALE_FRACTION = 0.2;

/** … but at least by this many bytes. */
const STALE_MIN_BYTES = 500;

/** Up to this total size the files of a group go into the deduplicate prompt in full. */
export const MAX_INLINE_GROUP_BYTES = 40000;

/** One wiki file as the dedup scan sees it. */
export interface FolderEntry {
    readonly path: string;
    readonly title: string;
    readonly description: string;
}

/** A pair of files a deduplicate run already looked at. */
export type HandledPair = {
    /** The lexically smaller path. */
    readonly pathA: string;
    readonly pathB: string;
    /** Sizes in bytes after the run. */
    readonly sizeA: number;
    readonly sizeB: number;
};

/** Result of parsing a dedup-scan reply. */
export interface ParsedScan {
    /** Candidate groups, each with 2–5 existing paths. */
    readonly groups: readonly (readonly string[])[];
    /** Why lines or paths were dropped, for the log. */
    readonly warnings: readonly string[];
}

/**
 * Groups wiki files by their top-level folder (`wiki/people/…` → `people`); a thread cluster
 * (`wiki/threads/sports-club/…`) belongs to `threads`. Files directly in `wiki/` (`questions.md`) belong to
 * no folder.
 *
 * @param paths - Workspace-relative wiki paths.
 * @returns Folder name → its paths, folders sorted.
 */
export function groupByTopFolder(paths: readonly string[]): ReadonlyMap<string, readonly string[]> {
    const folders = new Map<string, string[]>();
    for (const relativePath of paths) {
        const segments = relativePath.split("/");
        if (segments[0] !== WIKI_FOLDER || segments.length < 3) {
            continue;
        }
        const folder = segments[1];
        folders.set(folder, [...(folders.get(folder) ?? []), relativePath]);
    }
    return new Map([...folders.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Renders the prompt of one dedup-scan run.
 *
 * @param folder - Top-level folder name.
 * @param entries - Its files with title and description.
 * @returns The prompt.
 */
export function renderScanPrompt(folder: string, entries: readonly FolderEntry[]): string {
    const lines = entries.map(
        (entry) => `- ${entry.path} | ${entry.title} | ${entry.description || "(no description)"}`,
    );
    return `folder: ${WIKI_FOLDER}/${folder}\nfiles: ${entries.length}\n\nOne line per file: path | title | description\n\n${lines.join("\n")}`;
}

/**
 * Parses a dedup-scan reply: one group per line, paths separated by commas. Tolerates list
 * markers, backticks and quotes around paths and ignores lines without a wiki path. Paths that
 * don't exist are dropped, duplicates within a line too; a group keeps at most
 * {@link MAX_GROUP_SIZE} paths and needs at least two. Identical groups count once.
 *
 * @param reply - The handler's result text.
 * @param existing - Wiki paths that exist now.
 * @returns The groups and the warnings.
 */
export function parseScanReply(reply: string, existing: ReadonlySet<string>): ParsedScan {
    const groups: string[][] = [];
    const warnings: string[] = [];
    const seenGroups = new Set<string>();
    for (const rawLine of reply.split(/\r?\n/)) {
        const line = rawLine.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
        if (!line.includes(`${WIKI_FOLDER}/`)) {
            continue;
        }
        const paths: string[] = [];
        for (const token of line.split(",")) {
            const candidate = token.trim().replace(/^[`'"]+|[`'"]+$/g, "");
            if (!/^wiki\/\S+\.md$/.test(candidate)) {
                continue;
            }
            if (!existing.has(candidate)) {
                warnings.push(`${candidate} does not exist`);
                continue;
            }
            if (!paths.includes(candidate)) {
                paths.push(candidate);
            }
        }
        if (paths.length > MAX_GROUP_SIZE) {
            warnings.push(
                `group of ${paths.length} files cut to ${MAX_GROUP_SIZE}: ${paths.slice(MAX_GROUP_SIZE).join(", ")} dropped`,
            );
            paths.length = MAX_GROUP_SIZE;
        }
        if (paths.length < 2) {
            continue;
        }
        const key = [...paths].sort().join("\n");
        if (seenGroups.has(key)) {
            continue;
        }
        seenGroups.add(key);
        groups.push(paths);
    }
    return { groups, warnings };
}

/**
 * Every unordered pair of a group, each as `[smaller, larger]` path.
 *
 * @param group - Paths.
 * @returns The pairs.
 */
export function pairsOf(group: readonly string[]): readonly (readonly [string, string])[] {
    const sorted = [...new Set(group)].sort();
    const pairs: [string, string][] = [];
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            pairs.push([sorted[i], sorted[j]]);
        }
    }
    return pairs;
}

/**
 * Key of a pair in {@link DedupPairStore.listKeys}.
 *
 * @param pathA - Smaller path.
 * @param pathB - Larger path.
 * @returns The key.
 */
export function pairKey(pathA: string, pathB: string): string {
    return `${pathA}\n${pathB}`;
}

/**
 * Whether a file changed enough since a dedup run to look at its pairs again: by at least 20 % of
 * the size it had then, and at least 500 bytes, either way.
 *
 * @param storedBytes - Size after the dedup run.
 * @param currentBytes - Size now.
 * @returns `true` when the pair should be forgotten.
 */
export function isSizeChangeSignificant(storedBytes: number, currentBytes: number): boolean {
    const change = Math.abs(currentBytes - storedBytes);
    return change >= Math.max(storedBytes * STALE_FRACTION, STALE_MIN_BYTES);
}

/**
 * Renders the prompt of one deduplicate run: the paths and, when they are small enough together,
 * the file contents.
 *
 * @param contents - Path → content of every file of the group.
 * @returns The prompt.
 */
export function renderDeduplicatePrompt(contents: ReadonlyMap<string, string>): string {
    const paths = [...contents.keys()];
    const listing = `Possible duplicates:\n${paths.map((p) => `- ${p}`).join("\n")}`;
    const total = [...contents.values()].reduce(
        (sum, content) => sum + Buffer.byteLength(content, "utf8"),
        0,
    );
    if (total > MAX_INLINE_GROUP_BYTES) {
        return `${listing}\n\nThe files are too large to include here (${total} bytes together) — read them with fs_read.`;
    }
    const files = [...contents.entries()].map(
        ([filePath, content]) => `<file path="${filePath}">\n${content.trimEnd()}\n</file>`,
    );
    return `${listing}\n\n${files.join("\n\n")}`;
}

/**
 * The pairs earlier deduplicate runs handled, in `<schema>.dedup_pairs` next to the wiki index.
 */
export class DedupPairStore {
    private readonly index: WikiIndex;

    /**
     * @param index - The wiki index whose schema holds the table.
     */
    constructor(index: WikiIndex) {
        this.index = index;
    }

    /**
     * Lists every stored pair.
     *
     * @returns The pairs, sorted by path.
     */
    async list(): Promise<readonly HandledPair[]> {
        return this.index.db.query<HandledPair>(
            `SELECT path_a AS "pathA", path_b AS "pathB", size_a AS "sizeA", size_b AS "sizeB"
             FROM ${this.index.schema}.dedup_pairs ORDER BY path_a, path_b`,
        );
    }

    /**
     * The keys ({@link pairKey}) of every stored pair.
     *
     * @returns The key set.
     */
    async listKeys(): Promise<ReadonlySet<string>> {
        return new Set((await this.list()).map((pair) => pairKey(pair.pathA, pair.pathB)));
    }

    /**
     * Forgets every pair whose file is gone or changed significantly since the run.
     *
     * @param sizes - Path → current size of every wiki file.
     * @returns How many pairs were forgotten.
     */
    async prune(sizes: ReadonlyMap<string, number>): Promise<number> {
        const stale = (await this.list()).filter((pair) => {
            const sizeA = sizes.get(pair.pathA);
            const sizeB = sizes.get(pair.pathB);
            return (
                sizeA === undefined ||
                sizeB === undefined ||
                isSizeChangeSignificant(pair.sizeA, sizeA) ||
                isSizeChangeSignificant(pair.sizeB, sizeB)
            );
        });
        for (const pair of stale) {
            await this.index.db.query(
                `DELETE FROM ${this.index.schema}.dedup_pairs WHERE path_a = $1 AND path_b = $2`,
                [pair.pathA, pair.pathB],
            );
        }
        return stale.length;
    }

    /**
     * Stores (or refreshes) handled pairs.
     *
     * @param pairs - The pairs with their current sizes.
     * @returns Resolves once written.
     */
    async record(pairs: readonly HandledPair[]): Promise<void> {
        for (const pair of pairs) {
            await this.index.db.query(
                `INSERT INTO ${this.index.schema}.dedup_pairs (path_a, path_b, size_a, size_b)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (path_a, path_b)
                 DO UPDATE SET size_a = EXCLUDED.size_a, size_b = EXCLUDED.size_b, handled_at = now()`,
                [pair.pathA, pair.pathB, pair.sizeA, pair.sizeB],
            );
        }
    }
}
