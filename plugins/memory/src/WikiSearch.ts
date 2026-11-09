import type { WikiIndex } from "./WikiIndex.js";
import { isIsoDate, isMonthDay, normalizeText } from "./WikiText.js";

/** Most terms one search accepts. */
export const MAX_SEARCH_TERMS = 8;
/** Default number of files a search returns. */
export const DEFAULT_SEARCH_LIMIT = 10;
/** Default number of date lines a date search returns. */
export const DEFAULT_DATE_LIMIT = 50;
/**
 * Default `pg_trgm.word_similarity_threshold`: how close a term must come to some word sequence of
 * a field to count as a hit. 0.6 (postgres' default) tolerates one typo in a typical name while
 * keeping `Hartl` and `Harter` apart.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.6;
/** Terms up to this length are matched as whole tokens; trigrams are too coarse for them. */
const SHORT_TERM_LENGTH = 4;

/** Weights per field; a term's score in a file is the sum of its best similarity per field times these. */
export interface FieldWeights {
    readonly title: number;
    readonly category: number;
    readonly description: number;
    readonly heading: number;
    readonly body: number;
}

/** Default {@link FieldWeights}. */
export const DEFAULT_FIELD_WEIGHTS: FieldWeights = {
    title: 4,
    category: 3,
    description: 3,
    heading: 2,
    body: 1,
};

/** Tuning knobs of {@link searchFiles} (the eval varies them). */
export interface SearchOptions {
    /** Max files returned (default {@link DEFAULT_SEARCH_LIMIT}). */
    readonly limit?: number;
    /** Word-similarity threshold (default {@link DEFAULT_SIMILARITY_THRESHOLD}). */
    readonly similarityThreshold?: number;
    /** Field weights (default {@link DEFAULT_FIELD_WEIGHTS}). */
    readonly weights?: FieldWeights;
}

/** One file found by {@link searchFiles}. */
export interface FileHit {
    readonly path: string;
    readonly title: string;
    readonly description: string;
    readonly categories: readonly string[];
    /** The input terms (as given) that matched somewhere in the file. */
    readonly matchedTerms: readonly string[];
    /** The line matching the most terms, if any line matched. */
    readonly snippet: string | undefined;
    /** Headline trail of the snippet line. */
    readonly snippetTrail: string | undefined;
    /** Weighted similarity sum; only meaningful for ordering within one search. */
    readonly score: number;
}

/** One date occurrence found by {@link searchDates}. */
export interface DateHit {
    readonly path: string;
    readonly title: string;
    /** ISO first day. */
    readonly from: string;
    /** ISO last day (equals `from` for a full date). */
    readonly to: string;
    readonly lineNo: number;
    readonly snippet: string;
}

/** Date search query: a range, or a recurring month-day. */
export type DateQuery = { readonly from: string; readonly to: string } | { readonly day: string };

/** Result of {@link searchDates}. */
export interface DateSearchResult {
    readonly hits: readonly DateHit[];
    /** Whether more hits exist than were returned. */
    readonly isTruncated: boolean;
}

/** One category with the number of files carrying it. */
export interface CategoryCount {
    readonly category: string;
    readonly files: number;
}

/**
 * Cleans the agent's terms: trims, drops empties and duplicates (after normalization).
 *
 * @param terms - Raw terms.
 * @returns Pairs of the term as given and its normalized form.
 * @throws {Error} When no term is left or there are more than {@link MAX_SEARCH_TERMS}.
 */
export function prepareTerms(terms: readonly string[]): { raw: string; norm: string }[] {
    const prepared: { raw: string; norm: string }[] = [];
    for (const term of terms) {
        const raw = term.trim();
        const norm = normalizeText(raw);
        if (norm === "" || prepared.some((entry) => entry.norm === norm)) {
            continue;
        }
        prepared.push({ raw, norm });
    }
    if (prepared.length === 0) {
        throw new Error("memory search: give at least one non-empty term");
    }
    if (prepared.length > MAX_SEARCH_TERMS) {
        throw new Error(`memory search: at most ${MAX_SEARCH_TERMS} terms, got ${prepared.length}`);
    }
    return prepared;
}

/**
 * Searches the wiki for files matching any of the terms (OR). Each term is matched by trigram word
 * similarity against title, description, headings and body lines (short terms as whole tokens),
 * and against categories (exactly, or by trigram for longer terms, so `Immobilie` finds `immobilien`). Files are ranked by how many distinct terms they match, then by
 * the weighted similarity, then by recency.
 *
 * @param index - The index to search.
 * @param terms - 1–{@link MAX_SEARCH_TERMS} search terms.
 * @param options - Limit and tuning knobs.
 * @returns The best files, best first.
 * @throws {Error} When the terms are empty or too many.
 */
export async function searchFiles(
    index: WikiIndex,
    terms: readonly string[],
    options: SearchOptions = {},
): Promise<FileHit[]> {
    const prepared = prepareTerms(terms);
    const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT));
    const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const weights = options.weights ?? DEFAULT_FIELD_WEIGHTS;
    const s = index.schema;
    const rows = await index.db.transaction(async (query) => {
        await query("SELECT set_config('pg_trgm.word_similarity_threshold', $1, true)", [
            String(threshold),
        ]);
        return query<{
            path: string;
            title: string;
            description: string;
            categories: string[];
            ords: number[];
            score: number;
            snippet: string | null;
            snippet_trail: string | null;
        }>(
            `
            WITH t AS (
                SELECT term, ord::int AS ord, length(term) <= ${SHORT_TERM_LENGTH} AS is_short
                FROM unnest($1::text[]) WITH ORDINALITY AS u(term, ord)
            ),
            field_hits AS (
                SELECT f.path, t.ord, 'title' AS field, word_similarity(t.term, f.title_norm) * $2::float8 AS score
                FROM t JOIN ${s}.files f
                  ON (NOT t.is_short AND t.term <% f.title_norm)
                  OR (t.is_short AND to_tsvector('simple', f.title_norm) @@ plainto_tsquery('simple', t.term))
                UNION ALL
                SELECT f.path, t.ord, 'description', word_similarity(t.term, f.description_norm) * $4::float8
                FROM t JOIN ${s}.files f
                  ON (NOT t.is_short AND t.term <% f.description_norm)
                  OR (t.is_short AND to_tsvector('simple', f.description_norm) @@ plainto_tsquery('simple', t.term))
                UNION ALL
                SELECT f.path, t.ord, 'category',
                       CASE WHEN t.term = ANY (f.categories) THEN 1.0
                            ELSE word_similarity(t.term, array_to_string(f.categories, ' ')) END * $3::float8
                FROM t JOIN ${s}.files f
                  ON t.term = ANY (f.categories)
                  OR (NOT t.is_short AND t.term <% array_to_string(f.categories, ' '))
            ),
            line_hits AS (
                SELECT l.path, l.line_no, l.is_heading, t.ord,
                       CASE WHEN t.is_short THEN 1.0 ELSE word_similarity(t.term, l.text_norm) END
                           * CASE WHEN l.is_heading THEN $5::float8 ELSE $6::float8 END AS score
                FROM t JOIN ${s}.lines l
                  ON (NOT t.is_short AND t.term <% l.text_norm)
                  OR (t.is_short AND l.tsv @@ plainto_tsquery('simple', t.term))
            ),
            term_scores AS (
                SELECT path, ord, sum(best) AS score FROM (
                    SELECT path, ord, max(score) AS best FROM field_hits GROUP BY path, ord, field
                    UNION ALL
                    SELECT path, ord, max(score) AS best FROM line_hits GROUP BY path, ord, is_heading
                ) per_field
                GROUP BY path, ord
            ),
            ranked AS (
                SELECT path, array_agg(ord ORDER BY ord) AS ords, sum(score) AS score
                FROM term_scores GROUP BY path
            ),
            best_lines AS (
                SELECT DISTINCT ON (path) path, line_no
                FROM (
                    SELECT path, line_no, count(DISTINCT ord) AS terms, sum(score) AS score
                    FROM line_hits GROUP BY path, line_no
                ) per_line
                ORDER BY path, terms DESC, score DESC, line_no
            )
            SELECT f.path, f.title, f.description, f.categories, r.ords, r.score::float8 AS score,
                   l.text AS snippet, l.heading_trail AS snippet_trail
            FROM ranked r
            JOIN ${s}.files f ON f.path = r.path
            LEFT JOIN best_lines b ON b.path = r.path
            LEFT JOIN ${s}.lines l ON l.path = b.path AND l.line_no = b.line_no
            ORDER BY cardinality(r.ords) DESC, r.score DESC, f.last_touched DESC, f.path
            LIMIT $7::int
            `,
            [
                prepared.map((term) => term.norm),
                weights.title,
                weights.category,
                weights.description,
                weights.heading,
                weights.body,
                limit,
            ],
        );
    });
    return rows.map((row) => ({
        path: row.path,
        title: row.title,
        description: row.description,
        categories: row.categories,
        matchedTerms: row.ords.map((ord) => prepared[ord - 1].raw),
        snippet: row.snippet ?? undefined,
        snippetTrail: row.snippet_trail ?? undefined,
        score: Number(row.score),
    }));
}

/**
 * Validates a date query.
 *
 * @param query - Range or month-day.
 * @throws {Error} With a message naming the bad value.
 */
export function validateDateQuery(query: DateQuery): void {
    if ("day" in query) {
        if (!isMonthDay(query.day)) {
            throw new Error(
                `memory date search: day must be MM-DD (e.g. 07-12), got ${JSON.stringify(query.day)}`,
            );
        }
        return;
    }
    for (const [name, value] of [
        ["from", query.from],
        ["to", query.to],
    ] as const) {
        if (!isIsoDate(value)) {
            throw new Error(
                `memory date search: ${name} must be an ISO date YYYY-MM-DD, got ${JSON.stringify(value)}`,
            );
        }
    }
    if (query.from > query.to) {
        throw new Error(`memory date search: from (${query.from}) is after to (${query.to})`);
    }
}

/**
 * Lists the lines that mention a date in the range (overlapping month entries included), or —
 * for `{day}` — every full date on that month and day in any year.
 *
 * @param index - The index to search.
 * @param query - Range or month-day.
 * @param limit - Max lines (default {@link DEFAULT_DATE_LIMIT}).
 * @returns The lines ordered by date, then path and line.
 * @throws {Error} When the query is invalid.
 */
export async function searchDates(
    index: WikiIndex,
    query: DateQuery,
    limit: number = DEFAULT_DATE_LIMIT,
): Promise<DateSearchResult> {
    validateDateQuery(query);
    const s = index.schema;
    const isDay = "day" in query;
    const where = isDay ? "d.month_day = $1" : "d.date_from <= $2::date AND d.date_to >= $1::date";
    const values = isDay ? [query.day] : [query.from, query.to];
    const rows = await index.db.query<{
        path: string;
        title: string;
        date_from: string;
        date_to: string;
        line_no: number;
        snippet: string;
    }>(
        `SELECT d.path, f.title, to_char(d.date_from, 'YYYY-MM-DD') AS date_from,
                to_char(d.date_to, 'YYYY-MM-DD') AS date_to, d.line_no, d.snippet
         FROM ${s}.dates d JOIN ${s}.files f ON f.path = d.path
         WHERE ${where}
         ORDER BY d.date_from, d.date_to, d.path, d.line_no
         LIMIT ${Math.max(1, Math.floor(limit)) + 1}`,
        values,
    );
    const isTruncated = rows.length > limit;
    return {
        hits: rows.slice(0, limit).map((row) => ({
            path: row.path,
            title: row.title,
            from: row.date_from,
            to: row.date_to,
            lineNo: row.line_no,
            snippet: row.snippet,
        })),
        isTruncated,
    };
}

/**
 * Lists every category in use with its file count, most used first.
 *
 * @param index - The index.
 * @returns The categories.
 */
export async function listCategories(index: WikiIndex): Promise<CategoryCount[]> {
    const rows = await index.db.query<{ category: string; files: string }>(
        `SELECT category, count(*) AS files
         FROM ${index.schema}.files, unnest(categories) AS category
         GROUP BY category ORDER BY count(*) DESC, category`,
    );
    return rows.map((row) => ({ category: row.category, files: Number(row.files) }));
}
