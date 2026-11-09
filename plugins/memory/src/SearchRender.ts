import { markdownTable } from "@getfamiliar/shared";
import type { CategoryCount, DateQuery, DateSearchResult, FileHit } from "./WikiSearch.js";

/**
 * Markdown renderings of search results, shared by the agent tools, the CLI and the eval's LLM
 * stage (which must see exactly what the agent sees).
 */

/** Longest description / snippet shown in a table cell. */
const CELL_CHARS = 180;

/**
 * Renders a file search result as a markdown table.
 *
 * @param hits - Files, best first.
 * @param terms - The terms as sent, for the header line.
 * @returns Markdown; a plain sentence when nothing matched.
 */
export function renderFileHits(hits: readonly FileHit[], terms: readonly string[]): string {
    const quoted = terms.map((term) => `"${term}"`).join(", ");
    if (hits.length === 0) {
        return `No wiki file matches any of ${quoted}.`;
    }
    const rows = hits.map((hit) => [
        hit.path,
        hit.title,
        clip(hit.description),
        hit.categories.join(", "),
        `${hit.matchedTerms.length}/${terms.length}: ${hit.matchedTerms.join(", ")}`,
        hit.snippet === undefined ? "" : clip(hit.snippet),
    ]);
    const bestMatchCount = Math.max(...hits.map((hit) => hit.matchedTerms.length));
    const coverage =
        terms.length > 1 && bestMatchCount < terms.length
            ? ` No file matches all ${terms.length} terms; the best match ${bestMatchCount}.`
            : "";
    return `${hits.length} file(s) matching ${quoted}, most matched terms first.${coverage} A match is literal: check that a file is really about your subject, not just sharing a word with it.\n\n${markdownTable(
        ["Path", "Title", "Description", "Categories", "Matched", "Best line"],
        rows,
    )}`;
}

/**
 * Renders a date search result as a markdown table.
 *
 * @param result - Date lines, ordered by date.
 * @param query - The query, for the header line.
 * @returns Markdown; a plain sentence when nothing matched.
 */
export function renderDateHits(result: DateSearchResult, query: DateQuery): string {
    const label =
        "day" in query ? `on ${query.day} (any year)` : `between ${query.from} and ${query.to}`;
    if (result.hits.length === 0) {
        return `No wiki line mentions a date ${label}.`;
    }
    const rows = result.hits.map((hit) => [
        hit.from === hit.to ? hit.from : `${hit.from.slice(0, 7)} (month)`,
        hit.path,
        clip(hit.snippet),
    ]);
    const truncation = result.isTruncated
        ? "\n\nMore lines exist — narrow the range to see them."
        : "";
    return `${result.hits.length} line(s) with a date ${label}:\n\n${markdownTable(
        ["Date", "Path", "Line"],
        rows,
    )}${truncation}`;
}

/**
 * Renders the category list for the prompt.
 *
 * @param categories - Categories with file counts.
 * @returns A comma-separated list such as `family (12), property (4)`, or `(none)`.
 */
export function renderCategoryList(categories: readonly CategoryCount[]): string {
    if (categories.length === 0) {
        return "(none)";
    }
    return categories.map((entry) => `${entry.category} (${entry.files})`).join(", ");
}

/**
 * Shortens a cell text to {@link CELL_CHARS}.
 *
 * @param text - Cell text.
 * @returns The text, cut with `…` when too long.
 */
function clip(text: string): string {
    return text.length <= CELL_CHARS ? text : `${text.slice(0, CELL_CHARS - 1)}…`;
}
