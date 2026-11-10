import { FENCE_PATTERN, readFrontmatter } from "./WikiParser.js";
import { findNonIsoDates, isIsoDate, normalizeText } from "./WikiText.js";

/** Which convention a {@link LintProblem} breaks. */
export type LintRule =
    | "frontmatter"
    | "frontmatter-key"
    | "categories"
    | "review-at"
    | "non-iso-date";

/** One convention violation in a wiki file. */
export interface LintProblem {
    /** 1-based line number in the file. */
    readonly lineNo: number;
    /** The broken convention. */
    readonly rule: LintRule;
    /** What is wrong, and the fix when it is obvious. */
    readonly message: string;
}

/** The only frontmatter keys `skills/memory/SKILL.md` allows. */
const ALLOWED_FRONTMATTER_KEYS: readonly string[] = ["categories", "review_at"];

/** Most categories a file may have. */
const MAX_CATEGORIES = 3;

/** A category: one lower-case word, hyphens allowed between parts (`real-estate`). */
const CATEGORY_PATTERN = /^[\p{Ll}\p{N}]+(?:-[\p{Ll}\p{N}]+)*$/u;

/**
 * Checks a wiki file against the conventions of `skills/memory/SKILL.md` that code can decide:
 * valid frontmatter with only `categories` (inline list of 0–3 distinct lower-case words) and
 * `review_at` (ISO date), and every date in the body written as an ISO date. Pure; never throws.
 *
 * @param content - The file content.
 * @returns The problems, ordered by line; empty for a clean file.
 */
export function lintWikiFile(content: string): LintProblem[] {
    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    const problems: LintProblem[] = [];
    const frontmatterWarnings: string[] = [];
    const { bodyStart, frontmatter } = readFrontmatter(lines, frontmatterWarnings);
    for (const warning of frontmatterWarnings) {
        problems.push({ lineNo: 1, rule: "frontmatter", message: warning });
    }
    const frontmatterLines = bodyStart > 0 ? lines.slice(1, bodyStart - 1) : [];
    const keyLine = (key: string): number => {
        const index = frontmatterLines.findIndex((line) => line.startsWith(`${key}:`));
        return index < 0 ? 1 : index + 2;
    };

    for (const key of Object.keys(frontmatter)) {
        if (!ALLOWED_FRONTMATTER_KEYS.includes(key)) {
            problems.push({
                lineNo: keyLine(key),
                rule: "frontmatter-key",
                message: `unknown frontmatter key \`${key}\` — only \`categories\` and \`review_at\` are allowed; move its content into the body`,
            });
        }
    }
    problems.push(
        ...lintCategories(frontmatter.categories, frontmatterLines, keyLine("categories")),
    );
    problems.push(...lintReviewAt(frontmatter.review_at, keyLine("review_at")));
    problems.push(...lintBodyDates(lines, bodyStart));
    return problems.sort((a, b) => a.lineNo - b.lineNo);
}

/**
 * Checks the `categories` value and how it is written.
 *
 * @param raw - The parsed value (`undefined` when absent).
 * @param frontmatterLines - The raw frontmatter lines, without the `---` fences.
 * @param lineNo - Line of the `categories:` key.
 * @returns The problems.
 */
function lintCategories(
    raw: unknown,
    frontmatterLines: readonly string[],
    lineNo: number,
): LintProblem[] {
    if (raw === undefined) {
        return [];
    }
    const problems: LintProblem[] = [];
    const problem = (message: string): void => {
        problems.push({ lineNo, rule: "categories", message });
    };
    const keyLineText = frontmatterLines.find((line) => line.startsWith("categories:")) ?? "";
    if (keyLineText.slice("categories:".length).trim() === "") {
        problem("write `categories` as an inline list on one line: `categories: [a, b]`");
    }
    if (raw === null) {
        return problems;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length > MAX_CATEGORIES) {
        problem(
            `${values.length} categories — at most ${MAX_CATEGORIES} are allowed, keep the most important`,
        );
    }
    const seen = new Set<string>();
    for (const value of values) {
        if (typeof value !== "string" || value.trim() === "") {
            problem(`category ${JSON.stringify(value)} is not a word`);
            continue;
        }
        if (!CATEGORY_PATTERN.test(value)) {
            problem(`category \`${value}\` must be one lower-case word (hyphens allowed)`);
        }
        const normalized = normalizeText(value);
        if (seen.has(normalized)) {
            problem(`category \`${value}\` is listed twice`);
        }
        seen.add(normalized);
    }
    return problems;
}

/**
 * Checks `review_at`. YAML turns an unquoted ISO date into a `Date`, so both forms are fine.
 *
 * @param raw - The parsed value (`undefined` when absent).
 * @param lineNo - Line of the `review_at:` key.
 * @returns The problems.
 */
function lintReviewAt(raw: unknown, lineNo: number): LintProblem[] {
    if (raw === undefined || raw === null) {
        return [];
    }
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        return [];
    }
    if (typeof raw === "string" && isIsoDate(raw.trim())) {
        return [];
    }
    return [
        {
            lineNo,
            rule: "review-at",
            message: `review_at ${JSON.stringify(raw instanceof Date ? String(raw) : raw)} is not an ISO date (YYYY-MM-DD)`,
        },
    ];
}

/** One date the linter rewrote to ISO by itself. */
export interface DateReplacement {
    /** 1-based line number. */
    readonly lineNo: number;
    /** The date as it was written. */
    readonly from: string;
    /** Its ISO form. */
    readonly to: string;
}

/**
 * Rewrites every non-ISO date in the body whose ISO form is unambiguous (`12.07.2026 → 2026-07-12`,
 * `Juli 2026 → 2026-07`), exactly at the found position and nothing else — no judgement involved,
 * so no agent run is needed. Ambiguous dates (`03/04/2026`) stay for the repair handler. The line
 * count and the line endings are kept, so line numbers of other problems stay valid. Pure.
 *
 * @param content - The file content.
 * @returns The new content and every replacement made (empty when nothing changed).
 */
export function fixUnambiguousDates(content: string): {
    readonly content: string;
    readonly replacements: readonly DateReplacement[];
} {
    const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    const { bodyStart } = readFrontmatter(lines, []);
    const replacements: DateReplacement[] = [];
    forEachBodyLine(lines, bodyStart, (line, index) => {
        const fixable = findNonIsoDates(line).filter((date) => date.iso !== undefined);
        if (fixable.length === 0) {
            return;
        }
        let fixed = line;
        // Right to left, so earlier columns stay valid.
        for (const date of [...fixable].reverse()) {
            fixed = `${fixed.slice(0, date.column)}${date.iso}${fixed.slice(date.column + date.text.length)}`;
        }
        lines[index] = fixed;
        for (const date of fixable) {
            replacements.push({ lineNo: index + 1, from: date.text, to: date.iso ?? "" });
        }
    });
    return replacements.length === 0
        ? { content, replacements }
        : { content: lines.join(lineEnding), replacements };
}

/**
 * Calls `visit` for every body line outside code fences (fence lines themselves excluded).
 *
 * @param lines - All lines of the file.
 * @param bodyStart - Index of the first body line.
 * @param visit - Receives the line and its 0-based index.
 */
function forEachBodyLine(
    lines: readonly string[],
    bodyStart: number,
    visit: (line: string, index: number) => void,
): void {
    let isInFence = false;
    for (let index = bodyStart; index < lines.length; index++) {
        if (FENCE_PATTERN.test(lines[index])) {
            isInFence = !isInFence;
            continue;
        }
        if (!isInFence) {
            visit(lines[index], index);
        }
    }
}

/**
 * Finds non-ISO dates in the body, outside code fences.
 *
 * @param lines - All lines of the file.
 * @param bodyStart - Index of the first body line.
 * @returns One problem per date.
 */
function lintBodyDates(lines: readonly string[], bodyStart: number): LintProblem[] {
    const problems: LintProblem[] = [];
    forEachBodyLine(lines, bodyStart, (line, index) => {
        for (const date of findNonIsoDates(line)) {
            problems.push({
                lineNo: index + 1,
                rule: "non-iso-date",
                message:
                    date.iso === undefined
                        ? `"${date.text}" is not an ISO date — day and month order is ambiguous, decide from the context`
                        : `"${date.text}" is not an ISO date — write ${date.iso}`,
            });
        }
    });
    return problems;
}
