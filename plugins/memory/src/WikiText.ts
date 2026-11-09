/**
 * Text helpers shared by the wiki indexer and the search: normalization (so `Größler`,
 * `GROESSLER` and `größler` meet in the trigram index) and ISO-date extraction.
 */

/**
 * Normalizes text for indexing and searching: lower case, diacritics removed (`ü → u`), `ß → ss`,
 * runs of whitespace collapsed. Applied identically to stored text and to search terms, so the
 * database never needs `unaccent`.
 *
 * @param text - Raw text.
 * @returns The normalized text.
 */
export function normalizeText(text: string): string {
    return text
        .toLowerCase()
        .replace(/ß/g, "ss")
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** A date or date range found in a line of text. */
export interface ExtractedDate {
    /** First day, ISO `YYYY-MM-DD`. */
    readonly from: string;
    /** Last day, ISO `YYYY-MM-DD`; equals `from` for a full date. */
    readonly to: string;
}

/**
 * ISO dates and months that are not part of a longer token (a path like `journal/2026-07` or a
 * number like `12026-07-01` doesn't count).
 */
const ISO_DATE_PATTERN = /(?<![\w/.-])(\d{4})-(\d{2})(?:-(\d{2}))?(?![\w-])/g;

/** Years outside this range are treated as noise (ids, part numbers). */
const MIN_YEAR = 1900;
const MAX_YEAR = 2199;

/**
 * Extracts every ISO date (`2026-07-12`) and ISO month (`2026-07`) from a line. A month expands to
 * its first and last day. Invalid dates (`2026-02-30`, `2026-13`) and bare years are skipped.
 * Duplicates within the line are dropped.
 *
 * @param line - One line of text.
 * @returns The dates in order of appearance.
 */
export function extractIsoDates(line: string): ExtractedDate[] {
    const found: ExtractedDate[] = [];
    const seen = new Set<string>();
    for (const match of line.matchAll(ISO_DATE_PATTERN)) {
        const year = Number(match[1]);
        const month = Number(match[2]);
        if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) {
            continue;
        }
        const range =
            match[3] === undefined
                ? monthRange(year, month)
                : dayRange(year, month, Number(match[3]));
        if (!range) {
            continue;
        }
        const key = `${range.from}/${range.to}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        found.push(range);
    }
    return found;
}

/**
 * Builds the range of a single valid day.
 *
 * @param year - Full year.
 * @param month - Month 1–12.
 * @param day - Day of month.
 * @returns The one-day range, or `undefined` when the day doesn't exist in that month.
 */
function dayRange(year: number, month: number, day: number): ExtractedDate | undefined {
    if (day < 1 || day > daysInMonth(year, month)) {
        return undefined;
    }
    const iso = formatIsoDate(year, month, day);
    return { from: iso, to: iso };
}

/**
 * Builds the range covering a whole month.
 *
 * @param year - Full year.
 * @param month - Month 1–12.
 * @returns First to last day of the month.
 */
function monthRange(year: number, month: number): ExtractedDate {
    return {
        from: formatIsoDate(year, month, 1),
        to: formatIsoDate(year, month, daysInMonth(year, month)),
    };
}

/**
 * Number of days in a month, leap years included.
 *
 * @param year - Full year.
 * @param month - Month 1–12.
 * @returns 28–31.
 */
function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Formats a date as ISO `YYYY-MM-DD`.
 *
 * @param year - Full year.
 * @param month - Month 1–12.
 * @param day - Day of month.
 * @returns The ISO date string.
 */
export function formatIsoDate(year: number, month: number, day: number): string {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Checks whether a string is a valid ISO calendar date `YYYY-MM-DD`.
 *
 * @param value - Candidate string.
 * @returns `true` for an existing day.
 */
export function isIsoDate(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
        return false;
    }
    const month = Number(match[2]);
    return (
        month >= 1 &&
        month <= 12 &&
        dayRange(Number(match[1]), month, Number(match[3])) !== undefined
    );
}

/**
 * Checks whether a string is a valid month-and-day `MM-DD` (Feb 29 counts as valid).
 *
 * @param value - Candidate string.
 * @returns `true` for a day that exists in some year.
 */
export function isMonthDay(value: string): boolean {
    const match = /^(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
        return false;
    }
    const month = Number(match[1]);
    const day = Number(match[2]);
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(2024, month);
}
