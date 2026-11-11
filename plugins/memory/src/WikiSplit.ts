import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listWikiFiles, WIKI_FOLDER } from "./WikiIndex.js";

/** One wiki file above the size limit. */
export interface OversizedFile {
    /** Workspace-relative path. */
    readonly path: string;
    /** Size in bytes (UTF-8). */
    readonly bytes: number;
}

/** The two halves of a harness split. */
export interface SplitHalves {
    /** New content of the original file. */
    readonly first: string;
    /** Content of the new second file. */
    readonly second: string;
}

/** What a harness split wrote. */
export interface HarnessSplit {
    /** The original file, now holding the first half. */
    readonly path: string;
    /** The new file with the second half. */
    readonly secondPath: string;
}

/**
 * Lists every wiki file larger than the limit.
 *
 * @param workspaceDir - Absolute workspace path.
 * @param maxFileBytes - `memory.maxFileBytes`.
 * @returns The oversized files, largest first.
 */
export async function findOversizedFiles(
    workspaceDir: string,
    maxFileBytes: number,
): Promise<readonly OversizedFile[]> {
    const found: OversizedFile[] = [];
    for (const relativePath of await listWikiFiles(workspaceDir)) {
        const { size } = await fs.stat(path.join(workspaceDir, relativePath));
        if (size > maxFileBytes) {
            found.push({ path: relativePath, bytes: size });
        }
    }
    return found.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

/**
 * Size of a file on disk.
 *
 * @param workspaceDir - Absolute workspace path.
 * @param relativePath - Workspace-relative path.
 * @returns Bytes, or `undefined` when the file doesn't exist.
 */
export async function fileBytes(
    workspaceDir: string,
    relativePath: string,
): Promise<number | undefined> {
    try {
        return (await fs.stat(path.join(workspaceDir, relativePath))).size;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw err;
    }
}

/**
 * Cuts a wiki file into two roughly equal halves: at the `##` heading closest to the middle, else
 * at a `###` heading, else at a paragraph break, else at any line — never inside a code fence and
 * never inside the frontmatter, the h1 or the description. The first half ends with a wikilink to
 * the second; the second gets the same frontmatter, the title with ` (2)` and the description, so
 * it is found and understood on its own.
 *
 * @param content - The file content.
 * @param secondLink - Wikilink target of the second half (`threads/acme-2`).
 * @param fallbackTitle - Title to use when the file has no h1 (its slug).
 * @returns The halves, or `undefined` when the body has no line to cut at.
 */
export function splitInHalf(
    content: string,
    secondLink: string,
    fallbackTitle: string,
): SplitHalves | undefined {
    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    const head = readHead(lines);
    const cut = findCutLine(lines, head.bodyStart);
    if (cut === undefined) {
        return undefined;
    }
    const first = `${trimTrailingBlankLines(lines.slice(0, cut)).join("\n")}\n\n→ [[${secondLink}]]\n`;
    const secondHead = [
        ...lines.slice(0, head.frontmatterEnd),
        `# ${head.title ?? fallbackTitle} (2)`,
        "",
        ...(head.description.length > 0 ? [...head.description, ""] : []),
    ];
    const second = `${[...secondHead, ...trimTrailingBlankLines(lines.slice(cut))].join("\n")}\n`;
    return { first, second };
}

/**
 * Splits an oversized file in two on disk: the first half stays at its path, so links to it stay
 * valid; the second half goes to `<slug>-2.md` (or the next free `-N`).
 *
 * @param workspaceDir - Absolute workspace path.
 * @param relativePath - Workspace-relative path of the file.
 * @returns What was written, or `undefined` when the file has nowhere to cut.
 */
export async function applyHarnessSplit(
    workspaceDir: string,
    relativePath: string,
): Promise<HarnessSplit | undefined> {
    const absolutePath = path.join(workspaceDir, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    const secondPath = nextFreeSplitPath(workspaceDir, relativePath);
    const slug = path.posix.basename(relativePath, ".md");
    const secondLink = secondPath.slice(WIKI_FOLDER.length + 1, -".md".length);
    const halves = splitInHalf(content, secondLink, slug);
    if (halves === undefined) {
        return undefined;
    }
    await fs.writeFile(path.join(workspaceDir, secondPath), halves.second, "utf8");
    await fs.writeFile(absolutePath, halves.first, "utf8");
    return { path: relativePath, secondPath };
}

/**
 * The first `<slug>-N.md` (N ≥ 2) next to the file that doesn't exist yet.
 *
 * @param workspaceDir - Absolute workspace path.
 * @param relativePath - Workspace-relative path of the file.
 * @returns Workspace-relative path for the second half.
 */
function nextFreeSplitPath(workspaceDir: string, relativePath: string): string {
    const base = relativePath.slice(0, -".md".length);
    for (let suffix = 2; ; suffix++) {
        const candidate = `${base}-${suffix}.md`;
        if (!existsSync(path.join(workspaceDir, candidate))) {
            return candidate;
        }
    }
}

/** Where the head of a wiki file (frontmatter, h1, description) ends. */
interface FileHead {
    /** Index after the closing `---` of the frontmatter (0 without frontmatter). */
    readonly frontmatterEnd: number;
    /** Text of the h1, `undefined` without one. */
    readonly title: string | undefined;
    /** The description paragraph's lines (empty without one). */
    readonly description: readonly string[];
    /** Index of the first body line after the head. */
    readonly bodyStart: number;
}

/**
 * Locates frontmatter, h1 and description.
 *
 * @param lines - The file's lines.
 * @returns Their positions.
 */
function readHead(lines: readonly string[]): FileHead {
    let index = 0;
    let frontmatterEnd = 0;
    if (lines[0] === "---") {
        const closing = lines.indexOf("---", 1);
        if (closing > 0) {
            frontmatterEnd = closing + 1;
            index = frontmatterEnd;
        }
    }
    while (index < lines.length && lines[index].trim() === "") {
        index++;
    }
    if (index >= lines.length || !lines[index].startsWith("# ")) {
        return { frontmatterEnd, title: undefined, description: [], bodyStart: index };
    }
    const title = lines[index].slice(2).trim();
    index++;
    while (index < lines.length && lines[index].trim() === "") {
        index++;
    }
    const description: string[] = [];
    while (index < lines.length && isPlainParagraphLine(lines[index])) {
        description.push(lines[index]);
        index++;
    }
    return { frontmatterEnd, title, description, bodyStart: index };
}

/**
 * Whether a line continues a plain paragraph (not blank, no heading, list, quote, table or fence).
 *
 * @param line - The line.
 * @returns `true` for paragraph text.
 */
function isPlainParagraphLine(line: string): boolean {
    return line.trim() !== "" && !/^\s*(#|[-*+]\s|\d+[.)]\s|>|\||```|~~~)/.test(line);
}

/**
 * Picks the line the second half starts with: the candidate of the strongest kind (`##`, `###`,
 * paragraph break, any line) closest to the middle by bytes. A candidate must leave body content
 * in the first half.
 *
 * @param lines - The file's lines.
 * @param bodyStart - First body line.
 * @returns Index of the cut line, `undefined` when the body has fewer than two lines.
 */
function findCutLine(lines: readonly string[], bodyStart: number): number | undefined {
    const offsets: number[] = [];
    let total = 0;
    for (const line of lines) {
        offsets.push(total);
        total += Buffer.byteLength(line, "utf8") + 1;
    }
    const middle = total / 2;
    const candidates: { readonly index: number; readonly rank: number }[] = [];
    let isInFence = false;
    let hasBodyContent = false;
    for (let index = bodyStart; index < lines.length; index++) {
        const line = lines[index];
        const isFence = /^\s*(```|~~~)/.test(line);
        if (!isInFence && hasBodyContent && line.trim() !== "") {
            const rank = line.startsWith("## ")
                ? 0
                : line.startsWith("### ")
                  ? 1
                  : lines[index - 1].trim() === ""
                    ? 2
                    : 3;
            candidates.push({ index, rank });
        }
        if (isFence) {
            isInFence = !isInFence;
        }
        if (line.trim() !== "") {
            hasBodyContent = true;
        }
    }
    const distance = (index: number): number => Math.abs(offsets[index] - middle);
    const closest = (rank: number | undefined): number | undefined => {
        let best: number | undefined;
        for (const candidate of candidates) {
            if (rank !== undefined && candidate.rank !== rank) {
                continue;
            }
            if (best === undefined || distance(candidate.index) < distance(best)) {
                best = candidate.index;
            }
        }
        return best;
    };
    // A cut of a kind only counts when it falls into the middle half of the file, so the halves
    // stay roughly equal; otherwise try the next weaker kind.
    for (const rank of [0, 1, 2, 3]) {
        const best = closest(rank);
        if (best !== undefined && distance(best) <= total * MAX_CUT_DISTANCE_FRACTION) {
            return best;
        }
    }
    return closest(undefined);
}

/** How far from the middle (as a fraction of the file) a cut at a heading may lie. */
const MAX_CUT_DISTANCE_FRACTION = 0.25;

/**
 * Drops blank lines at the end.
 *
 * @param lines - Lines.
 * @returns The lines without trailing blanks.
 */
function trimTrailingBlankLines(lines: readonly string[]): string[] {
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim() === "") {
        end--;
    }
    return lines.slice(0, end);
}
