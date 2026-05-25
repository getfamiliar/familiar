import type { ConfigService, Logger } from "@getfamiliar/shared";
import type { MemoryConfig } from "./Config.js";
import {
    buildEmbeddingModel,
    type EmbeddingProviderType,
    PROVIDERS_WITHOUT_EMBEDDINGS,
} from "./EmbeddingModelFactory.js";
import { type HandshakeResult, handshakeEmbeddings } from "./EmbeddingsBootstrap.js";
import { MemoryStore, memoryDataDir } from "./MemoryStore.js";

/**
 * Vercel AI SDK providers we ship and that expose embeddings. Keyed
 * by id (also the URL segment under `inference.apiKeys.<id>`); value
 * is the {@link EmbeddingProviderType} the factory dispatches on.
 *
 * Native providers without embeddings (anthropic, deepseek, grok,
 * groq) are intentionally absent so the resolver below produces a
 * precise "<provider> does not expose embeddings" error rather than
 * "unknown provider".
 */
const NATIVE_EMBEDDING_PROVIDERS: Readonly<Record<string, EmbeddingProviderType>> = {
    openai: "openai",
    google: "google",
    mistral: "mistral",
};

/**
 * Bundle returned to the plugin's daemon `start()` after a successful
 * handshake — the live store plus the resolved identity so the
 * caller can log it.
 */
export interface BuiltStore {
    readonly store: MemoryStore;
    readonly providerLabel: string;
    readonly dimension: number;
    readonly indexInvalidated: boolean;
}

/**
 * Resolve the embedding provider config, run the handshake, and (on
 * success) build a {@link MemoryStore} ready for `init()` +
 * `kickoffBackgroundSync()`. Returns `null` and logs the reason when
 * the handshake fails — the caller should leave the plugin loaded
 * but disabled.
 */
export async function buildMemoryStore(
    cfg: MemoryConfig,
    config: ConfigService,
    dataDir: string,
    workspaceDir: string,
    log: Logger,
): Promise<BuiltStore | null> {
    const resolved = resolveEmbeddingProvider(cfg.embeddings.provider, config);
    const embeddingModel = buildEmbeddingModel({
        provider: cfg.embeddings.provider,
        type: resolved.type,
        model: cfg.embeddings.model,
        apiKey: resolved.apiKey,
        baseUrl: resolved.baseUrl,
    });

    const memDir = memoryDataDir(dataDir);
    const handshake: HandshakeResult = await handshakeEmbeddings({
        dataDir: memDir,
        provider: cfg.embeddings.provider,
        model: cfg.embeddings.model,
        embeddingModel,
        log,
    });
    if (!handshake.ready) {
        log.error(
            {
                reason: handshake.reason,
                provider: cfg.embeddings.provider,
                model: cfg.embeddings.model,
            },
            "memory: embedding handshake failed — plugin disabled",
        );
        return null;
    }
    log.info(
        {
            provider: cfg.embeddings.provider,
            model: cfg.embeddings.model,
            dimension: handshake.identity.dimension,
        },
        `memory: using embedding ${cfg.embeddings.provider}/${cfg.embeddings.model}, validated and found to use ${handshake.identity.dimension} dimensions`,
    );

    const store = new MemoryStore({
        dataDir: memDir,
        workspaceDir,
        embeddingModel,
        dimension: handshake.identity.dimension,
        language: cfg.language,
        hybridWeights: cfg.hybridWeights,
        minVectorSimilarity: cfg.minVectorSimilarity,
        persistToDiskDelay: cfg.persistToDiskDelay,
        excludeGlobs: cfg.excludeGlobs,
        log,
    });

    return {
        store,
        providerLabel: `${cfg.embeddings.provider}/${cfg.embeddings.model}`,
        dimension: handshake.identity.dimension,
        indexInvalidated: handshake.indexInvalidated,
    };
}

/**
 * Match a provider id against the inference config. Returns the
 * resolved embedding provider type, api key, and (for custom
 * providers) base URL. Throws — with a precise message — when:
 *  - the provider id is not declared under either inference subtree;
 *  - the provider is native but does not expose embeddings;
 *  - the custom provider's `type` is unsupported.
 */
function resolveEmbeddingProvider(
    providerId: string,
    config: ConfigService,
): { readonly type: EmbeddingProviderType; readonly apiKey: string; readonly baseUrl?: string } {
    // Native first — `inference.apiKeys.<id>` is a flat key→string map.
    const nativeKey = config.getString(`inference.apiKeys.${providerId}`, null);
    if (typeof nativeKey === "string" && nativeKey.length > 0) {
        if (PROVIDERS_WITHOUT_EMBEDDINGS.includes(providerId)) {
            throw new Error(
                `memory: inference provider "${providerId}" does not expose embeddings — pick openai, google, mistral, or an openai-compatible gateway`,
            );
        }
        const type = NATIVE_EMBEDDING_PROVIDERS[providerId];
        if (!type) {
            throw new Error(
                `memory: inference provider "${providerId}" is not a known native provider for embeddings (known: ${Object.keys(NATIVE_EMBEDDING_PROVIDERS).join(", ")})`,
            );
        }
        return { type, apiKey: nativeKey };
    }
    // Custom provider — read the trio `apiKey`, `baseUrl`, `type`.
    const customApiKey = config.getString(`inference.customProviders.${providerId}.apiKey`, null);
    if (typeof customApiKey !== "string" || customApiKey.length === 0) {
        throw new Error(
            `memory: embeddings provider "${providerId}" is not declared under inference.apiKeys nor inference.customProviders`,
        );
    }
    const baseUrl = config.getString(`inference.customProviders.${providerId}.baseUrl`);
    const customType = config.getString(
        `inference.customProviders.${providerId}.type`,
        "openai-compatible",
    );
    if (customType !== "openai-compatible") {
        throw new Error(
            `memory: custom provider "${providerId}" has type "${customType}" — only "openai-compatible" is supported for embeddings`,
        );
    }
    return { type: "openai-compatible", apiKey: customApiKey, baseUrl };
}
