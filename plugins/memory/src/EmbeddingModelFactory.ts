import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel } from "ai";

/**
 * Provider types that ship an embeddings endpoint via the Vercel AI
 * SDK. Mirrors the container's {@link ModelFactory} provider set with
 * the providers that do **not** offer embeddings stripped out
 * (anthropic, grok, groq, deepseek). Adding a new embedding provider
 * means: install its `@ai-sdk/<id>` package, extend this union, extend
 * {@link buildEmbeddingModel}'s switch.
 */
export type EmbeddingProviderType = "openai" | "google" | "mistral" | "openai-compatible";

/** Options the plugin's `index.ts` resolves from the host config tree. */
export interface BuildEmbeddingModelOptions {
    /** Provider id as it appears in `inference.{apiKeys|customProviders}.<id>`. */
    readonly provider: string;
    /** Provider's flavor — picks which `@ai-sdk/*` SDK class to use. */
    readonly type: EmbeddingProviderType;
    /** Embedding model id (e.g. `text-embedding-3-small`). */
    readonly model: string;
    /** Real upstream API key (from the inference config). */
    readonly apiKey: string;
    /** Optional base URL — required for `openai-compatible`, defaulted by native SDKs. */
    readonly baseUrl?: string;
}

/**
 * Build a Vercel AI SDK {@link EmbeddingModel} for the requested
 * provider + model. Pure factory — no host coupling, no module-level
 * cache (the memory plugin only ever resolves one embedding model per
 * process, so caching would be premature).
 *
 * Throws when the provider type doesn't ship embeddings (the unsupported
 * types are not in {@link EmbeddingProviderType}, so callers normally
 * fail at compile time; this guards the runtime decision in
 * `index.ts` that resolves the host's config).
 */
export function buildEmbeddingModel(opts: BuildEmbeddingModelOptions): EmbeddingModel {
    switch (opts.type) {
        case "openai": {
            const client = createOpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
            return client.textEmbeddingModel(opts.model);
        }
        case "google": {
            const client = createGoogleGenerativeAI({
                apiKey: opts.apiKey,
                baseURL: opts.baseUrl,
            });
            return client.textEmbeddingModel(opts.model);
        }
        case "mistral": {
            const client = createMistral({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
            return client.textEmbeddingModel(opts.model);
        }
        case "openai-compatible": {
            if (!opts.baseUrl) {
                throw new Error(
                    `memory: embeddings provider "${opts.provider}" is openai-compatible but has no baseUrl — set inference.customProviders.${opts.provider}.baseUrl`,
                );
            }
            const client = createOpenAICompatible({
                name: opts.provider,
                apiKey: opts.apiKey,
                baseURL: opts.baseUrl,
            });
            return client.textEmbeddingModel(opts.model);
        }
    }
}

/**
 * Provider ids known to ship a Vercel AI SDK class but **without** an
 * embedding endpoint. Used by `index.ts` to produce a precise error
 * message ("anthropic does not expose embeddings — pick openai,
 * google, mistral, or an openai-compatible gateway") instead of
 * dropping into the generic "unknown provider" path.
 */
export const PROVIDERS_WITHOUT_EMBEDDINGS: readonly string[] = [
    "anthropic",
    "deepseek",
    "grok",
    "groq",
];
