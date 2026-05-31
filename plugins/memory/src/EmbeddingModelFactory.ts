import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel } from "ai";

/** Options the plugin's `index.ts` resolves from the host config tree. */
export interface BuildEmbeddingModelOptions {
    /** Provider id as configured under `inference.apiKeys.<id>` — used in messages. */
    readonly provider: string;
    /**
     * The provider's SDK npm package (from model metadata) — picks which
     * `@ai-sdk/*` embedding client to build.
     */
    readonly npmPackage: string;
    /** Embedding model id (e.g. `text-embedding-3-small`). */
    readonly model: string;
    /** Real upstream API key (from the inference config). */
    readonly apiKey: string;
    /** Optional base URL — required for `@ai-sdk/openai-compatible`, defaulted by native SDKs. */
    readonly baseUrl?: string;
}

/**
 * Build a Vercel AI SDK {@link EmbeddingModel} for the requested
 * provider, selecting the SDK client from the provider's **npm package**
 * (mirroring the container's `ModelFactory`). Pure factory — no host
 * coupling, no module-level cache (the memory plugin only ever resolves
 * one embedding model per process, so caching would be premature).
 *
 * Only npm packages that ship a text-embedding endpoint are supported
 * (`@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/mistral`, and
 * `@ai-sdk/openai-compatible`). A provider whose package doesn't (e.g.
 * `@ai-sdk/anthropic`) throws a precise error.
 */
export function buildEmbeddingModel(opts: BuildEmbeddingModelOptions): EmbeddingModel {
    switch (opts.npmPackage) {
        case "@ai-sdk/openai": {
            const client = createOpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
            return client.textEmbeddingModel(opts.model);
        }
        case "@ai-sdk/google": {
            const client = createGoogleGenerativeAI({
                apiKey: opts.apiKey,
                baseURL: opts.baseUrl,
            });
            return client.textEmbeddingModel(opts.model);
        }
        case "@ai-sdk/mistral": {
            const client = createMistral({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
            return client.textEmbeddingModel(opts.model);
        }
        case "@ai-sdk/openai-compatible": {
            if (!opts.baseUrl) {
                throw new Error(
                    `memory: embeddings provider "${opts.provider}" is openai-compatible but has no apiEndpoint — the provider's model metadata must supply one`,
                );
            }
            const client = createOpenAICompatible({
                name: opts.provider,
                apiKey: opts.apiKey,
                baseURL: opts.baseUrl,
            });
            return client.textEmbeddingModel(opts.model);
        }
        default:
            throw new Error(
                `memory: embeddings provider "${opts.provider}" uses npm package "${opts.npmPackage}", which does not expose embeddings — pick a provider backed by @ai-sdk/openai, @ai-sdk/google, @ai-sdk/mistral, or an openai-compatible gateway`,
            );
    }
}
