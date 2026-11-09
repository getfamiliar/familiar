import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import { type DateQuery, MAX_SEARCH_TERMS } from "./WikiSearch.js";
import { isIsoDate, isMonthDay } from "./WikiText.js";

/**
 * Loader and structural validator for the memory eval set (`eval/cases.yml`, format described in
 * `eval/README.md`). Shared by the `familiar memory eval` runner and `eval/ValidateCases.ts`.
 */

/** Corpus languages; each case carries one query and one relevance map per language. */
export const EVAL_LANGUAGES = ["de", "en"] as const;

/** A corpus language. */
export type EvalLanguage = (typeof EVAL_LANGUAGES)[number];

/** Known case categories, in README order. Case ids must be `<category>-<nn>`. */
export const EVAL_CATEGORIES = [
    "exact-name",
    "typo",
    "compound",
    "inflection",
    "synonym",
    "semantic",
    "date",
    "noise",
    "duplicate",
    "cross-language",
    "long-prompt",
    "keyword-salad",
    "abbreviation",
    "distractor",
    "negative",
] as const;

/** A case category. */
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

/** Relevance grades: 2 = must be found, 1 = acceptable. */
const GRADES = new Set([1, 2]);

/** Keys a case may carry; anything else is reported as a typo. */
const ALLOWED_CASE_KEYS = new Set([
    "id",
    "category",
    "origin",
    "query",
    "terms",
    "dates",
    "relevant",
    "crossLanguage",
]);

/** One validated eval case. */
export interface EvalCase {
    /** Unique id, `<category>-<nn>`. */
    readonly id: string;
    /** Case category. */
    readonly category: EvalCategory;
    /** One generic sentence on the real-world problem the case mirrors. */
    readonly origin: string;
    /** The user's prompt per language (input of the LLM stage). */
    readonly query: Readonly<Record<EvalLanguage, string>>;
    /**
     * The search terms a careful agent would send per language (input of the deterministic stage);
     * absent for pure date cases.
     */
    readonly terms: Readonly<Record<EvalLanguage, readonly string[]>> | undefined;
    /** The date search a careful agent would run (same in both languages), if any. */
    readonly dates: DateQuery | undefined;
    /** Workspace-relative path → grade (1 or 2) per language; empty for negative cases. */
    readonly relevant: Readonly<Record<EvalLanguage, ReadonlyMap<string, number>>>;
    /** When true, the EN query is additionally run against the DE corpus, judged by `relevant.de`. */
    readonly crossLanguage: boolean;
}

/** Result of {@link loadEvalCases}: the valid cases plus every problem found. */
export interface EvalCaseSet {
    /** Cases that passed validation, in file order. */
    readonly cases: readonly EvalCase[];
    /** Human-readable problem messages; empty when the whole file is valid. */
    readonly problems: readonly string[];
    /** Number of entries in the file, valid or not. */
    readonly totalEntries: number;
}

/**
 * Returns the eval folder shipped next to the plugin's `src/` / `build/` directory.
 *
 * @returns Absolute path of `plugins/memory/eval/`.
 */
export function defaultEvalDir(): string {
    return path.join(import.meta.dirname, "..", "eval");
}

/**
 * Checks whether a value is a plain (non-array) object.
 *
 * @param value - Any parsed YAML value.
 * @returns `true` for plain objects.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a value is a non-empty string after trimming.
 *
 * @param value - Any parsed YAML value.
 * @returns `true` for non-blank strings.
 */
function isNonBlankString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * Checks whether a value is one of the known case categories.
 *
 * @param value - Any parsed YAML value.
 * @returns `true` when the value names a known category.
 */
function isEvalCategory(value: unknown): value is EvalCategory {
    return typeof value === "string" && (EVAL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Validates and converts one relevance map of a case.
 *
 * @param caseId - Id of the case, for messages.
 * @param language - Corpus language of the map.
 * @param map - The parsed `relevant.<language>` value.
 * @param corpusDir - Absolute path of `corpus/<language>/`.
 * @returns Problem messages (empty when valid) and the converted map.
 */
function readRelevanceMap(
    caseId: string,
    language: EvalLanguage,
    map: unknown,
    corpusDir: string,
): { readonly problems: string[]; readonly grades: Map<string, number> } {
    const grades = new Map<string, number>();
    if (!isPlainObject(map)) {
        return {
            problems: [`${caseId}: relevant.${language} must be a map (use {} for negative cases)`],
            grades,
        };
    }
    const problems: string[] = [];
    for (const [relativePath, grade] of Object.entries(map)) {
        if (!GRADES.has(grade as number)) {
            problems.push(
                `${caseId}: relevant.${language} "${relativePath}" has grade ${String(grade)}, expected 1 or 2`,
            );
        }
        if (!relativePath.startsWith("wiki/")) {
            problems.push(
                `${caseId}: relevant.${language} "${relativePath}" is outside wiki/ (only the wiki is indexed)`,
            );
        }
        if (!relativePath.endsWith(".md")) {
            problems.push(
                `${caseId}: relevant.${language} "${relativePath}" is not a markdown file`,
            );
        }
        if (!fs.existsSync(path.join(corpusDir, relativePath))) {
            problems.push(
                `${caseId}: relevant.${language} "${relativePath}" does not exist in corpus/${language}/`,
            );
        }
        grades.set(relativePath, grade as number);
    }
    return { problems, grades };
}

/**
 * Validates the `terms` map of a case: per language a list of 1–8 non-blank strings.
 *
 * @param caseId - Id of the case, for messages.
 * @param value - The parsed `terms` value.
 * @param problems - Collects problem messages.
 * @returns The terms, or `undefined` when absent or invalid.
 */
function readTerms(
    caseId: string,
    value: unknown,
    problems: string[],
): Record<EvalLanguage, string[]> | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isPlainObject(value)) {
        problems.push(`${caseId}: terms must be a map of language → list`);
        return undefined;
    }
    const terms: Partial<Record<EvalLanguage, string[]>> = {};
    for (const language of EVAL_LANGUAGES) {
        const list = value[language];
        if (
            !Array.isArray(list) ||
            list.length === 0 ||
            list.length > MAX_SEARCH_TERMS ||
            !list.every(isNonBlankString)
        ) {
            problems.push(
                `${caseId}: terms.${language} must be a list of 1–${MAX_SEARCH_TERMS} non-blank strings`,
            );
            continue;
        }
        terms[language] = list as string[];
    }
    return terms.de && terms.en ? (terms as Record<EvalLanguage, string[]>) : undefined;
}

/**
 * Validates the `dates` of a case: `{from, to}` (ISO dates) or `{day}` (`MM-DD`).
 *
 * @param caseId - Id of the case, for messages.
 * @param value - The parsed `dates` value.
 * @param problems - Collects problem messages.
 * @returns The date query, or `undefined` when absent or invalid.
 */
function readDates(caseId: string, value: unknown, problems: string[]): DateQuery | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (isPlainObject(value) && typeof value.day === "string" && Object.keys(value).length === 1) {
        if (isMonthDay(value.day)) {
            return { day: value.day };
        }
    } else if (
        isPlainObject(value) &&
        typeof value.from === "string" &&
        typeof value.to === "string" &&
        Object.keys(value).length === 2
    ) {
        if (isIsoDate(value.from) && isIsoDate(value.to) && value.from <= value.to) {
            return { from: value.from, to: value.to };
        }
    }
    problems.push(
        `${caseId}: dates must be { from: YYYY-MM-DD, to: YYYY-MM-DD } or { day: MM-DD }`,
    );
    return undefined;
}

/**
 * Validates one raw case and converts it.
 *
 * @param rawCase - One parsed list entry of `cases.yml`.
 * @param index - Position in the list, for messages about cases without an id.
 * @param seenIds - Ids seen so far; the case's id is added.
 * @param evalDir - Absolute path of the eval folder.
 * @returns Problem messages and the converted case, which is `null` when any problem was found.
 */
function readCase(
    rawCase: unknown,
    index: number,
    seenIds: Set<string>,
    evalDir: string,
): { readonly problems: string[]; readonly evalCase: EvalCase | null } {
    if (!isPlainObject(rawCase)) {
        return { problems: [`case #${index + 1}: not a map`], evalCase: null };
    }
    const problems: string[] = [];
    const caseId = isNonBlankString(rawCase.id) ? rawCase.id : `case #${index + 1}`;
    if (!isNonBlankString(rawCase.id)) {
        problems.push(`${caseId}: missing id`);
    } else if (seenIds.has(rawCase.id)) {
        problems.push(`${caseId}: duplicate id`);
    } else {
        seenIds.add(rawCase.id);
    }
    for (const key of Object.keys(rawCase)) {
        if (!ALLOWED_CASE_KEYS.has(key)) {
            problems.push(`${caseId}: unknown key "${key}"`);
        }
    }

    const category = rawCase.category;
    if (!isEvalCategory(category)) {
        problems.push(`${caseId}: unknown category "${String(category)}"`);
    } else if (!new RegExp(`^${category}-\\d{2}$`).test(caseId)) {
        problems.push(`${caseId}: id must be "${category}-<nn>"`);
    }
    if (!isNonBlankString(rawCase.origin)) {
        problems.push(`${caseId}: missing origin`);
    }
    if (rawCase.crossLanguage !== undefined && typeof rawCase.crossLanguage !== "boolean") {
        problems.push(`${caseId}: crossLanguage must be a boolean`);
    }

    const queryValue = rawCase.query;
    const relevantValue = rawCase.relevant;
    const query: Partial<Record<EvalLanguage, string>> = {};
    const relevant: Partial<Record<EvalLanguage, Map<string, number>>> = {};
    for (const language of EVAL_LANGUAGES) {
        const languageQuery = isPlainObject(queryValue) ? queryValue[language] : undefined;
        if (!isNonBlankString(languageQuery)) {
            problems.push(`${caseId}: missing query.${language}`);
        } else {
            query[language] = languageQuery;
        }
        const map = readRelevanceMap(
            caseId,
            language,
            isPlainObject(relevantValue) ? relevantValue[language] : undefined,
            path.join(evalDir, "corpus", language),
        );
        problems.push(...map.problems);
        relevant[language] = map.grades;
        const isNegative = category === "negative";
        if (isNegative && map.grades.size > 0) {
            problems.push(`${caseId}: negative cases must have empty relevance maps`);
        }
        if (!isNegative && map.grades.size === 0 && map.problems.length === 0) {
            problems.push(
                `${caseId}: relevant.${language} is empty but the category is not "negative"`,
            );
        }
    }

    const terms = readTerms(caseId, rawCase.terms, problems);
    const dates = readDates(caseId, rawCase.dates, problems);
    if (terms === undefined && dates === undefined) {
        problems.push(`${caseId}: needs terms, dates or both`);
    }

    if (problems.length > 0 || !isEvalCategory(category)) {
        return { problems, evalCase: null };
    }
    return {
        problems,
        evalCase: {
            id: caseId,
            category,
            origin: rawCase.origin as string,
            query: query as Record<EvalLanguage, string>,
            terms,
            dates,
            relevant: relevant as Record<EvalLanguage, Map<string, number>>,
            crossLanguage: rawCase.crossLanguage === true,
        },
    };
}

/**
 * Loads and validates `cases.yml` from an eval folder.
 *
 * @param evalDir - Absolute path of the eval folder (holds `cases.yml` and `corpus/`).
 * @returns The valid cases, every problem found and the number of entries.
 * @throws {Error} When `cases.yml` cannot be read or is not valid YAML.
 */
export function loadEvalCases(evalDir: string): EvalCaseSet {
    const parsed: unknown = parse(fs.readFileSync(path.join(evalDir, "cases.yml"), "utf8"));
    if (!Array.isArray(parsed)) {
        return { cases: [], problems: ["cases.yml must be a YAML list of cases"], totalEntries: 0 };
    }
    const seenIds = new Set<string>();
    const problems: string[] = [];
    const cases: EvalCase[] = [];
    parsed.forEach((rawCase, index) => {
        const result = readCase(rawCase, index, seenIds, evalDir);
        problems.push(...result.problems);
        if (result.evalCase !== null) {
            cases.push(result.evalCase);
        }
    });
    return { cases, problems, totalEntries: parsed.length };
}
