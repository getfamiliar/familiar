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

/** A date in a non-ISO notation found in a line. */
export interface NonIsoDate {
    /** The date as written, e.g. `12.07.2026` or `July 12, 2026`. */
    readonly text: string;
    /** 0-based column in the line. */
    readonly column: number;
    /** The ISO form (`2026-07-12`, `2026-07` for a month), when it is unambiguous. */
    readonly iso: string | undefined;
}

/** Month names and abbreviations (German and English), lower case, mapped to 1–12. */
const MONTH_NUMBERS: ReadonlyMap<string, number> = new Map(
    (
        [
            [1, ["januar", "jänner", "january", "jan"]],
            [2, ["februar", "february", "feb"]],
            [3, ["märz", "maerz", "march", "mär", "mar"]],
            [4, ["april", "apr"]],
            [5, ["mai", "may"]],
            [6, ["juni", "june", "jun"]],
            [7, ["juli", "july", "jul"]],
            [8, ["august", "aug"]],
            [9, ["september", "sept", "sep"]],
            [10, ["oktober", "october", "okt", "oct"]],
            [11, ["november", "nov"]],
            [12, ["dezember", "december", "dez", "dec"]],
        ] as const
    ).flatMap(([month, names]) => names.map((name) => [name, month] as const)),
);

/** Alternation of every month name, longest first so `Juni` wins over `Jun`. */
const MONTH_ALTERNATION = [...MONTH_NUMBERS.keys()].sort((a, b) => b.length - a.length).join("|");

/**
 * Non-ISO date notations, each with a function that turns the match into year / month / day
 * candidates. Order matters: earlier patterns claim their span first, so `12. Juli 2026` is one
 * finding, not also `Juli 2026`.
 */
const NON_ISO_PATTERNS: readonly {
    readonly pattern: RegExp;
    readonly toIso: (match: RegExpMatchArray) => string | undefined | null;
}[] = [
    {
        // 12.07.2026, 12.7.26 — always day first.
        pattern: /(?<![\w.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?![\w]|\.\d)/g,
        toIso: (m) => isoFromParts(fullYear(m[3]), Number(m[2]), Number(m[1])),
    },
    {
        // 07/12/2026 — day or month first; only unambiguous when one part is above 12. A four-digit
        // year is required: `8/10/11` is far more often a list (tram lines) than a date.
        pattern: /(?<![\w/.:])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\w/])/g,
        toIso: (m) => {
            const first = Number(m[1]);
            const second = Number(m[2]);
            const year = fullYear(m[3]);
            if (first > 12 && second <= 12) {
                return isoFromParts(year, second, first);
            }
            if (second > 12 && first <= 12) {
                return isoFromParts(year, first, second);
            }
            const dayFirst = isoFromParts(year, second, first);
            const monthFirst = isoFromParts(year, first, second);
            if (dayFirst === null && monthFirst === null) {
                return null;
            }
            return first === second ? (dayFirst ?? undefined) : undefined;
        },
    },
    {
        // 12. Juli 2026, 12 July 2026, 12th of July, 2026
        pattern: new RegExp(
            `(?<![\\w.])(\\d{1,2})(?:\\.|st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_ALTERNATION})\\.?,?\\s+(\\d{4})(?![\\w-])`,
            "giu",
        ),
        toIso: (m) => isoFromParts(Number(m[3]), monthNumber(m[2]), Number(m[1])),
    },
    {
        // July 12, 2026 / Jul 12th 2026
        pattern: new RegExp(
            `(?<![\\w])(${MONTH_ALTERNATION})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?![\\w-])`,
            "giu",
        ),
        toIso: (m) => isoFromParts(Number(m[3]), monthNumber(m[1]), Number(m[2])),
    },
    {
        // Juli 2026, July 2026 — a month without a day.
        pattern: new RegExp(`(?<![\\w.])(${MONTH_ALTERNATION})\\.?\\s+(\\d{4})(?![\\w-])`, "giu"),
        toIso: (m) => {
            const year = Number(m[2]);
            const month = monthNumber(m[1]);
            return year >= MIN_YEAR && year <= MAX_YEAR && month !== undefined
                ? `${String(year)}-${String(month).padStart(2, "0")}`
                : null;
        },
    },
];

/**
 * Finds dates written in a notation other than ISO 8601: `12.07.2026`, `07/12/2026` (four-digit
 * year only),
 * `12. Juli 2026`, `July 12, 2026`, `Juli 2026` (German and English month names). Inline code
 * spans, URLs and wikilinks are skipped; impossible dates (`31.02.2026`, `13/13/2026`) don't count,
 * which keeps version numbers like `1.2.3` out. Dates without a year (`12. Mai`) are not reported:
 * they have no ISO form.
 *
 * @param line - One line of text (outside code fences).
 * @returns The findings in order of appearance.
 */
export function findNonIsoDates(line: string): NonIsoDate[] {
    const masked = maskIgnoredSpans(line);
    const claimed: boolean[] = new Array(line.length).fill(false);
    const found: NonIsoDate[] = [];
    for (const { pattern, toIso } of NON_ISO_PATTERNS) {
        for (const match of masked.matchAll(pattern)) {
            const column = match.index ?? 0;
            const end = column + match[0].length;
            if (claimed.slice(column, end).some(Boolean)) {
                continue;
            }
            const iso = toIso(match);
            if (iso === null) {
                continue;
            }
            claimed.fill(true, column, end);
            found.push({ text: line.slice(column, end), column, iso });
        }
    }
    return found.sort((a, b) => a.column - b.column);
}

/**
 * Replaces inline code, URLs and wikilinks with spaces of the same length, so pattern matches keep
 * their column but never fire inside them.
 *
 * @param line - The line.
 * @returns The masked line.
 */
function maskIgnoredSpans(line: string): string {
    return line.replace(/`[^`]*`|\[\[[^\]]*\]\]|\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (span) =>
        " ".repeat(span.length),
    );
}

/**
 * Turns a two- or four-digit year into a full year (`26 → 2026`, `85 → 1985`).
 *
 * @param raw - The digits.
 * @returns The full year.
 */
function fullYear(raw: string): number {
    const value = Number(raw);
    if (raw.length === 4) {
        return value;
    }
    return value < 70 ? 2000 + value : 1900 + value;
}

/**
 * Looks up a month name.
 *
 * @param name - Month name or abbreviation, any case.
 * @returns 1–12, or `undefined` for an unknown name.
 */
function monthNumber(name: string): number | undefined {
    return MONTH_NUMBERS.get(name.toLowerCase());
}

/**
 * Validates year / month / day and formats them as ISO.
 *
 * @param year - Full year.
 * @param month - Month 1–12 (or `undefined`).
 * @param day - Day of month.
 * @returns The ISO date, or `null` when no such day exists (then the match is not a date at all).
 */
function isoFromParts(year: number, month: number | undefined, day: number): string | null {
    if (month === undefined || month < 1 || month > 12 || year < MIN_YEAR || year > MAX_YEAR) {
        return null;
    }
    return dayRange(year, month, day)?.from ?? null;
}
