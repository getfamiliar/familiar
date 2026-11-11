import type { ConfigService } from "@getfamiliar/shared";
import { DREAM_CRITERIA, type DreamCounts } from "./WikiDream.js";
import { DEFAULT_SEARCH_LIMIT, DEFAULT_SIMILARITY_THRESHOLD } from "./WikiSearch.js";

/**
 * Plugin-side view of the `memory:` subtree in `config/config.yml`. Every key has a default, so the
 * plugin works without any `memory:` section. Read per use (never cached), so `familiar config
 * reload` applies changes from the next search on.
 */
export interface MemoryConfig {
    /** Files `memory_search` returns. */
    readonly searchLimit: number;
    /** `pg_trgm` word-similarity threshold for a term to count as a hit (0–1). */
    readonly similarityThreshold: number;
    /** When the linter checks every wiki file (friendly or raw cron expression). */
    readonly lintSchedule: string;
    /** When files with a due `review_at` are handed to the review handler. */
    readonly reviewSchedule: string;
    /** Size in bytes above which a wiki file is handed to the split handler. */
    readonly maxFileBytes: number;
    /** When oversized files are handed to the split handler. */
    readonly splitSchedule: string;
    /** When the wiki is scanned for duplicates. */
    readonly dedupSchedule: string;
    /** The dream pass (`memory.dream.*`). */
    readonly dream: DreamConfig;
}

/** `memory.dream.*`. */
export interface DreamConfig {
    /** When the dream pass runs. */
    readonly schedule: string;
    /** Files per selection criterion. */
    readonly counts: DreamCounts;
    /** Days a dreamed file is not picked again. */
    readonly lockDays: number;
}

/** Default of `memory.dream.schedule`: after the other nightly jobs, before the morning review. */
export const DEFAULT_DREAM_SCHEDULE = "every day at 05:00";

/** Defaults of `memory.dream.<criterion>`. */
export const DEFAULT_DREAM_COUNTS: DreamCounts = {
    changed: 3,
    hot: 2,
    cold: 2,
    oldest: 1,
    random: 1,
};

/**
 * Default of the core key `core.fileReadRetentionDays` (how long the host keeps
 * `file_reads`), which is also the window of the "hot" criterion.
 */
export const DEFAULT_FILE_READ_RETENTION_DAYS = 14;

/** Default of `memory.dream.lockDays`. */
export const DEFAULT_DREAM_LOCK_DAYS = 7;

/** Default of `memory.lintSchedule`: at night, so repairs are done by the morning. */
export const DEFAULT_LINT_SCHEDULE = "every day at 03:00";

/** Default of `memory.reviewSchedule`: in the morning, so messages to the user arrive at a sensible hour. */
export const DEFAULT_REVIEW_SCHEDULE = "every day at 07:00";

/** Default of `memory.maxFileBytes`: about 4–5k tokens, so a run can read several files whole. */
export const DEFAULT_MAX_FILE_BYTES = 15000;

/** Default of `memory.splitSchedule`: before the linter, so it lints the split results. */
export const DEFAULT_SPLIT_SCHEDULE = "every day at 02:00";

/** Default of `memory.dedupSchedule`: once a week, at night. */
export const DEFAULT_DEDUP_SCHEDULE = "every saturday at 03:00";

/**
 * Reads the memory config.
 *
 * @param config - The host config service.
 * @returns The config with defaults applied.
 * @throws {Error} When a value is out of range.
 */
export function readMemoryConfig(config: ConfigService): MemoryConfig {
    const searchLimit = config.getNumber("memory.searchLimit", DEFAULT_SEARCH_LIMIT);
    const similarityThreshold = config.getNumber(
        "memory.similarityThreshold",
        DEFAULT_SIMILARITY_THRESHOLD,
    );
    if (!Number.isInteger(searchLimit) || searchLimit < 1 || searchLimit > 50) {
        throw new Error(
            `memory.searchLimit must be an integer between 1 and 50, got ${searchLimit}`,
        );
    }
    if (!(similarityThreshold > 0 && similarityThreshold <= 1)) {
        throw new Error(`memory.similarityThreshold must be in (0, 1], got ${similarityThreshold}`);
    }
    const lintSchedule =
        config.getString("memory.lintSchedule", DEFAULT_LINT_SCHEDULE) ?? DEFAULT_LINT_SCHEDULE;
    const reviewSchedule =
        config.getString("memory.reviewSchedule", DEFAULT_REVIEW_SCHEDULE) ??
        DEFAULT_REVIEW_SCHEDULE;
    const maxFileBytes = config.getNumber("memory.maxFileBytes", DEFAULT_MAX_FILE_BYTES);
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 2000) {
        throw new Error(
            `memory.maxFileBytes must be an integer of at least 2000, got ${maxFileBytes}`,
        );
    }
    const splitSchedule =
        config.getString("memory.splitSchedule", DEFAULT_SPLIT_SCHEDULE) ?? DEFAULT_SPLIT_SCHEDULE;
    const dedupSchedule =
        config.getString("memory.dedupSchedule", DEFAULT_DEDUP_SCHEDULE) ?? DEFAULT_DEDUP_SCHEDULE;
    return {
        dream: readDreamConfig(config),
        searchLimit,
        similarityThreshold,
        lintSchedule,
        reviewSchedule,
        maxFileBytes,
        splitSchedule,
        dedupSchedule,
    };
}

/**
 * Reads `memory.dream.*`.
 *
 * @param config - The host config service.
 * @returns The dream config with defaults applied.
 * @throws {Error} When a count is no integer ≥ 0 or the lock period no integer ≥ 1.
 */
function readDreamConfig(config: ConfigService): DreamConfig {
    const schedule =
        config.getString("memory.dream.schedule", DEFAULT_DREAM_SCHEDULE) ?? DEFAULT_DREAM_SCHEDULE;
    const counts = Object.fromEntries(
        DREAM_CRITERIA.map((criterion) => {
            const value = config.getNumber(
                `memory.dream.${criterion}`,
                DEFAULT_DREAM_COUNTS[criterion],
            );
            if (!Number.isInteger(value) || value < 0) {
                throw new Error(
                    `memory.dream.${criterion} must be an integer of at least 0, got ${value}`,
                );
            }
            return [criterion, value];
        }),
    ) as unknown as DreamCounts;
    const lockDays = config.getNumber("memory.dream.lockDays", DEFAULT_DREAM_LOCK_DAYS);
    if (!Number.isInteger(lockDays) || lockDays < 1) {
        throw new Error(`memory.dream.lockDays must be an integer of at least 1, got ${lockDays}`);
    }
    return { schedule, counts, lockDays };
}
