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
 * **references** an entry already declared under `inference.apiKeys.<id>`;
 * the plugin resolves the api key + the provider's npm package / upstream
 * endpoint via `ctx.inference.resolveProvider` (models.dev or a plugin
 * descriptor) — no duplication of credentials in the `memory:` subtree.
 * Only providers whose SDK ships embeddings work (openai, google,
 * mistral, or an openai-compatible gateway).
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
     * Score floor for the injected `# Memories` table: files whose best
     * hit scores at or below this are dropped from the table, so only
     * reasonably relevant files are listed. Range 0–1.
     */
    readonly minScoreToMention: number;
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
     * Paths that count as the assistant's own curated memory. In the
     * injected `# Memories` table these select the **description
     * source**: a writable-path file is described by its first
     * paragraph (the memory convention), while any other file (e.g. a
     * handler like `mail/index.md`) is described by its `description:`
     * frontmatter — never its body, which is instruction prose that
     * could pose as direction addressed at the agent.
     *
     * Sourced from the platform-level `core.writablePaths` (default
     * `["wiki/**"]`) — the same allowlist the container fs tools use to
     * decide what a non-privileged run may write. Substring-with-`*`
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
    const minScoreToMention = config.getNumber("memory.minScoreToMention", 0.55);
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
        minScoreToMention,
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
