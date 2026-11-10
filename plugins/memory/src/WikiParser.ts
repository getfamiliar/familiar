import path from "node:path";
import { parse as parseYaml } from "yaml";
import { extractIsoDates, isIsoDate, normalizeText } from "./WikiText.js";

/** One indexed line of a wiki file. */
export interface WikiLine {
    /** 1-based line number in the original file (frontmatter lines included). */
    readonly lineNo: number;
    /** Whether the line is a markdown heading. */
    readonly isHeading: boolean;
    /** The headline trail the line sits under, e.g. `Alice Smith > Meetings`. */
    readonly headingTrail: string;
    /** The line, trimmed; headings without their `#` markers. */
    readonly text: string;
}

/** One date occurrence in a wiki file. */
export interface WikiDate {
    /** 1-based line number. */
    readonly lineNo: number;
    /** First day, ISO. */
    readonly from: string;
    /** Last day, ISO (equals `from` for a full date). */
    readonly to: string;
    /** The line the date stands in, trimmed. */
    readonly snippet: string;
}

/** Everything the index stores about one wiki file. */
export interface ParsedWikiFile {
    /** The first h1, or the file name without extension. */
    readonly title: string;
    /** The first plain paragraph directly under the h1; empty when there is none. */
    readonly description: string;
    /** `categories` from the frontmatter, normalized ({@link normalizeText}). */
    readonly categories: readonly string[];
    /** `review_at` from the frontmatter (ISO date), if valid. */
    readonly reviewAt: string | undefined;
    /** Every non-blank line outside the frontmatter. */
    readonly lines: readonly WikiLine[];
    /** Every ISO date and month found in the lines. */
    readonly dates: readonly WikiDate[];
    /** Problems worth telling the user about (invalid frontmatter values). */
    readonly warnings: readonly string[];
}

const HEADING_PATTERN = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
/** A line opening or closing a code fence. */
export const FENCE_PATTERN = /^\s*(```|~~~)/;
/** Lines that start a block other than a plain paragraph. */
const NON_PARAGRAPH_PATTERN = /^\s*([-*+]\s|\d+[.)]\s|>|\||<|```|~~~|#)/;

/**
 * Parses a wiki markdown file into the fields the index needs. Never throws: malformed frontmatter
 * is reported as a warning and ignored.
 *
 * @param relativePath - Workspace-relative path, used for the fallback title.
 * @param content - The file content.
 * @returns The parsed file.
 */
export function parseWikiFile(relativePath: string, content: string): ParsedWikiFile {
    const allLines = content.replace(/\r\n?/g, "\n").split("\n");
    const warnings: string[] = [];
    const { bodyStart, frontmatter } = readFrontmatter(allLines, warnings);
    const categories = readCategories(frontmatter, warnings);
    const reviewAt = readReviewAt(frontmatter, warnings);

    const lines: WikiLine[] = [];
    const dates: WikiDate[] = [];
    const trail: string[] = [];
    let title: string | undefined;
    let isInFence = false;
    let isCollectingDescription = false;
    let hasSeenDescriptionBlock = false;
    const descriptionLines: string[] = [];

    for (let index = bodyStart; index < allLines.length; index++) {
        const raw = allLines[index];
        const lineNo = index + 1;
        const trimmed = raw.trim();
        if (FENCE_PATTERN.test(raw)) {
            isInFence = !isInFence;
        }
        const heading = isInFence ? null : HEADING_PATTERN.exec(raw);

        if (isCollectingDescription) {
            if (trimmed === "" || heading || NON_PARAGRAPH_PATTERN.test(raw)) {
                isCollectingDescription = false;
            } else {
                descriptionLines.push(trimmed);
            }
        } else if (title !== undefined && !hasSeenDescriptionBlock && trimmed !== "") {
            hasSeenDescriptionBlock = true;
            if (!heading && !NON_PARAGRAPH_PATTERN.test(raw)) {
                isCollectingDescription = true;
                descriptionLines.push(trimmed);
            }
        }

        if (trimmed === "") {
            continue;
        }
        if (heading) {
            const level = heading[1].length;
            const text = heading[2];
            if (level === 1 && title === undefined) {
                title = text;
            }
            if (level <= 3) {
                trail.length = level - 1;
                trail[level - 1] = text;
            }
            lines.push({
                lineNo,
                isHeading: true,
                headingTrail: trail.filter(Boolean).join(" > "),
                text,
            });
        } else {
            lines.push({
                lineNo,
                isHeading: false,
                headingTrail: trail.filter(Boolean).join(" > "),
                text: trimmed,
            });
        }
        for (const date of extractIsoDates(trimmed)) {
            dates.push({ lineNo, from: date.from, to: date.to, snippet: trimmed });
        }
    }
    return {
        title: title ?? path.basename(relativePath, ".md"),
        description: descriptionLines.join(" "),
        categories,
        reviewAt,
        lines,
        dates,
        warnings,
    };
}

/**
 * Reads the YAML frontmatter block at the top of the file, if any.
 *
 * @param lines - All lines of the file.
 * @param warnings - Collects parse problems.
 * @returns Index of the first body line and the frontmatter mapping (empty when absent).
 */
export function readFrontmatter(
    lines: readonly string[],
    warnings: string[],
): { bodyStart: number; frontmatter: Record<string, unknown> } {
    if (lines[0]?.trim() !== "---") {
        return { bodyStart: 0, frontmatter: {} };
    }
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end < 0) {
        warnings.push("frontmatter is not closed with `---`");
        return { bodyStart: 0, frontmatter: {} };
    }
    try {
        const parsed: unknown = parseYaml(lines.slice(1, end).join("\n"));
        if (parsed === null || parsed === undefined) {
            return { bodyStart: end + 1, frontmatter: {} };
        }
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
            warnings.push("frontmatter is not a YAML mapping");
            return { bodyStart: end + 1, frontmatter: {} };
        }
        return { bodyStart: end + 1, frontmatter: parsed as Record<string, unknown> };
    } catch (err) {
        warnings.push(
            `frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { bodyStart: end + 1, frontmatter: {} };
    }
}

/**
 * Reads `categories` (a list of strings, or one string) from the frontmatter.
 *
 * @param frontmatter - The parsed frontmatter.
 * @param warnings - Collects problems.
 * @returns Normalized, de-duplicated categories.
 */
function readCategories(frontmatter: Record<string, unknown>, warnings: string[]): string[] {
    const raw = frontmatter.categories;
    if (raw === undefined || raw === null) {
        return [];
    }
    const values = Array.isArray(raw) ? raw : [raw];
    const categories: string[] = [];
    for (const value of values) {
        if (typeof value !== "string" || value.trim() === "") {
            warnings.push(`categories: ignoring non-text entry ${JSON.stringify(value)}`);
            continue;
        }
        const category = normalizeText(value);
        if (!categories.includes(category)) {
            categories.push(category);
        }
    }
    return categories;
}

/**
 * Reads `review_at` from the frontmatter. YAML turns an unquoted ISO date into a `Date`, so both
 * forms are accepted.
 *
 * @param frontmatter - The parsed frontmatter.
 * @param warnings - Collects problems.
 * @returns The ISO date, or `undefined` when absent or invalid.
 */
function readReviewAt(
    frontmatter: Record<string, unknown>,
    warnings: string[],
): string | undefined {
    const raw = frontmatter.review_at;
    if (raw === undefined || raw === null) {
        return undefined;
    }
    const value =
        raw instanceof Date && !Number.isNaN(raw.getTime()) ? raw.toISOString().slice(0, 10) : raw;
    if (typeof value === "string" && isIsoDate(value.trim())) {
        return value.trim();
    }
    warnings.push(`review_at: ${JSON.stringify(raw)} is not an ISO date (YYYY-MM-DD)`);
    return undefined;
}
