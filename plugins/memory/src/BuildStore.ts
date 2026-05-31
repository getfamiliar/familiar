import type { HostContext, Logger } from "@getfamiliar/shared";
import type { MemoryConfig } from "./Config.js";
import { buildEmbeddingModel } from "./EmbeddingModelFactory.js";
import { type HandshakeResult, handshakeEmbeddings } from "./EmbeddingsBootstrap.js";
import { MemoryStore, memoryDataDir } from "./MemoryStore.js";

/** Provider resolver, as exposed by `ctx.inference.resolveProvider`. */
type ResolveProvider = HostContext["inference"]["resolveProvider"];

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
    resolveProvider: ResolveProvider,
    dataDir: string,
    workspaceDir: string,
    log: Logger,
): Promise<BuiltStore | null> {
    const resolved = await resolveEmbeddingProvider(cfg.embeddings.provider, resolveProvider);
    const embeddingModel = buildEmbeddingModel({
        provider: cfg.embeddings.provider,
        npmPackage: resolved.npmPackage,
        model: cfg.embeddings.model,
        apiKey: resolved.apiKey,
        baseUrl: resolved.apiEndpoint,
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
 * Resolve an embedding provider id against the platform's provider
 * resolution (`ctx.inference.resolveProvider`): the api key from
 * `inference.apiKeys.<id>` joined with the provider's npm package +
 * upstream endpoint from model metadata (models.dev or a plugin
 * descriptor). The embedding client is built directly against the
 * upstream — it does not go through the bastion — so it needs the real
 * key + endpoint.
 *
 * Whether the resolved npm package actually exposes embeddings is
 * decided by {@link buildEmbeddingModel}; this only fails when the
 * provider isn't configured / isn't a known provider.
 *
 * @throws When the provider id has no api key configured or doesn't
 *   resolve to a known provider.
 */
async function resolveEmbeddingProvider(
    providerId: string,
    resolveProvider: ResolveProvider,
): Promise<{
    readonly npmPackage: string;
    readonly apiKey: string;
    readonly apiEndpoint?: string;
}> {
    const resolved = await resolveProvider(providerId);
    if (resolved === undefined) {
        throw new Error(
            `memory: embeddings provider "${providerId}" is not configured under inference.apiKeys, or is not a known provider (not in the models.dev catalogue and not declared by a plugin)`,
        );
    }
    return {
        npmPackage: resolved.npmPackage,
        apiKey: resolved.apiKey,
        apiEndpoint: resolved.apiEndpoint,
    };
}
