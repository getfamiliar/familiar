import type { ConfigService } from "@getfamiliar/shared";
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
}

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
    return { searchLimit, similarityThreshold };
}
