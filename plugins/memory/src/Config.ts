import type { ConfigService } from "@getfamiliar/shared";

/**
 * Configured weights for the hybrid (vector + BM25) search Orama
 * performs. Both numbers in [0,1]; they do not have to sum to 1. The
 * defaults give equal say to dense and lexical signals — bias toward
 * vector when the wiki is rich in synonyms / paraphrases, toward text
 * when distinctive proper nouns dominate.
 */
export interface HybridWeights {
    readonly vector: number;
    readonly text: number;
}

/**
 * Embedding-provider half of the memory config. The provider id
 * **references** an entry already declared under either
 * `inference.apiKeys.<id>` (native) or `inference.customProviders.<id>`
 * (third-party gateway). The plugin reads the api key and (for custom
 * providers) the base URL from that existing block — no duplication of
 * credentials in the `memory:` subtree.
 */
export interface EmbeddingsConfig {
    /** Inference provider id; must match an enabled provider. */
    readonly provider: string;
    /** Embedding model id under the provider, e.g. `text-embedding-3-small`. */
    readonly model: string;
}

/**
 * Plugin-side view of the `memory:` subtree in `config/config.yml`. The
 * platform-level `ConfigLinter` does not police these keys — the plugin
 * owns validation of its own subtree (CLAUDE.md). Every key but the
 * embedding identity (`embeddings.provider`, `embeddings.model`) has a
 * usable default so a working install only has to declare those two.
 */
export interface MemoryConfig {
    /**
     * Hits with hybrid score strictly greater than this get the full
     * chunk injected into the system prompt by the contextProvider.
     * Range 0–1.
     */
    readonly minScoreToEmbed: number;
    /**
     * Hits with score strictly greater than this (but ≤ `minScoreToEmbed`)
     * get a path-only "see also" mention. Range 0–1.
     */
    readonly minScoreToMention: number;
    /**
     * Hard cap on full-snippet chunks per file in the system-prompt
     * injection. Extra chunks get summarized as "And N more…".
     */
    readonly maxChunksPerFile: number;
    /** How many hits the contextProvider asks the backend for. */
    readonly maxSystemPromptMemoryResults: number;
    /** Default `limit` for the `memory_search` tool when the agent omits it. */
    readonly maxToolMemoryResults: number;
    /**
     * Glob patterns to exclude from indexing. Empty by default; future
     * carve-out for problem subfolders (e.g. compressed chat snapshots
     * that would surface as memories of themselves). Substring-with-`*`
     * grammar — same as `WorkspaceFileFilter.pathGlob`.
     */
    readonly excludeGlobs: readonly string[];
    /**
     * Paths whose hits are eligible for **full-snippet injection** into
     * the system prompt. Hits scored above {@link minScoreToEmbed} but
     * whose path doesn't match any of these patterns are demoted to the
     * "See also" block (path-only, with score percentage), so
     * authoritative-sounding handler files (`mail/index.md`,
     * `chat/index.md`, …) can't be mistaken by the agent for
     * instructions addressed at it.
     *
     * Sourced from the platform-level `core.writablePaths` (default
     * `["wiki/**"]`) — the same allowlist the container fs tools use to
     * decide what a non-privileged run may write. The two views unify
     * "the assistant's own curated memory": those paths are both
     * writable by handlers and quoted in full here. Substring-with-`*`
     * grammar.
     */
    readonly writablePaths: readonly string[];
    /** Embedding provider + model. Required for the index to come up. */
    readonly embeddings: EmbeddingsConfig;
    /**
     * Stemmer + stopwords language. Defaults to `english`. Unknown
     * language is logged with the supported list and falls back to
     * english.
     */
    readonly language: string;
    /** Hybrid (vector vs. text) weights handed to Orama on every search. */
    readonly hybridWeights: HybridWeights;
    /**
     * Cosine-similarity floor below which vector hits are discarded
     * before being merged with the text hits. Orama's built-in default
     * is `0.8` — too strict for general-purpose embedding models like
     * `text-embedding-3-small`, where semantically related but not
     * identical content typically scores 0.3–0.7. Default here is
     * `0.3`: permissive enough that the vector side actually
     * contributes, strict enough to drop pure noise. Tune up if
     * search starts surfacing irrelevant matches.
     */
    readonly minVectorSimilarity: number;
    /**
     * Idle seconds before the dirty index is flushed to disk. Reset on
     * every index mutation; explicit final flush on plugin `stop()`.
     */
    readonly persistToDiskDelay: number;
}

/**
 * Read the plugin's config subtree with safe defaults. Throws when
 * `memory.embeddings.provider` or `memory.embeddings.model` is missing
 * — the plugin cannot index without those, and a silent disable would
 * mask a configuration mistake from someone who clearly *wanted* the
 * feature on. Callers that want the plugin to self-disable on missing
 * config should catch and log.
 */
export function readMemoryConfig(config: ConfigService): MemoryConfig {
    const minScoreToEmbed = config.getNumber("memory.minScoreToEmbed", 0.75);
    const minScoreToMention = config.getNumber("memory.minScoreToMention", 0.55);
    const maxChunksPerFile = config.getNumber("memory.maxChunksPerFile", 3);
    const maxSystemPromptMemoryResults = config.getNumber("memory.maxSystemPromptMemoryResults", 8);
    const maxToolMemoryResults = config.getNumber("memory.maxToolMemoryResults", 5);
    const rawExcludes = config.getArray("memory.excludeGlobs", []);
    const excludeGlobs: string[] = [];
    for (const entry of rawExcludes) {
        if (typeof entry === "string" && entry.length > 0) {
            excludeGlobs.push(entry);
        }
    }
    const writablePaths = config.getStringList("core.writablePaths", ["wiki/**"]);
    const embeddings: EmbeddingsConfig = {
        provider: config.getString("memory.embeddings.provider"),
        model: config.getString("memory.embeddings.model"),
    };
    const language = config.getString("memory.language", "english");
    const hybridWeights: HybridWeights = {
        vector: config.getNumber("memory.hybridWeights.vector", 0.5),
        text: config.getNumber("memory.hybridWeights.text", 0.5),
    };
    const minVectorSimilarity = config.getNumber("memory.minVectorSimilarity", 0.3);
    const persistToDiskDelay = config.getNumber("memory.persistToDiskDelay", 30);
    return {
        minScoreToEmbed,
        minScoreToMention,
        maxChunksPerFile,
        maxSystemPromptMemoryResults,
        maxToolMemoryResults,
        excludeGlobs,
        writablePaths,
        embeddings,
        language,
        hybridWeights,
        minVectorSimilarity,
        persistToDiskDelay,
    };
}
