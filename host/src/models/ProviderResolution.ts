import { resolveUpstreamBase } from "../bastion/NpmProviderProfiles.js";

/**
 * A fully-resolved inference provider: the config-supplied key + api key
 * joined with the provider-level metadata (`npmPackage` / `apiEndpoint`)
 * that says how to talk to it. Produced by `PluginHost.resolveProvider`
 * and consumed by the reverse proxy (`buildProviders`) and the container
 * env (`INFERENCE_PROVIDERS` = `{ key: npmPackage }`).
 */
export interface ResolvedProvider {
    /** Provider key — `inference.apiKeys.<key>` / `/llm/<key>/` route. */
    readonly key: string;
    /** Real upstream API key from `inference.apiKeys.<key>`. */
    readonly apiKey: string;
    /** SDK npm package (selects `create*` + auth style + default base). */
    readonly npmPackage: string;
    /** Upstream base from metadata; absent when the npm default applies. */
    readonly apiEndpoint?: string;
}

/**
 * Provider-level metadata lookup, as exposed by
 * {@link import("./ModelMetadataService.js").ModelMetadataService.lookupProvider}.
 */
export type ProviderMetaLookup = (
    key: string,
) => Promise<{ npmPackage?: string; apiEndpoint?: string } | undefined>;

/**
 * Validate that every `inference.apiKeys.<key>` resolves to a usable
 * provider: known to models.dev or a plugin (`npmPackage` present), with
 * a supported npm package and a resolvable upstream base (an
 * openai-compatible gateway must carry an `apiEndpoint`). Pure-ish: does
 * not read config itself — the caller passes the parsed `apiKeys` keys
 * and a provider-metadata lookup.
 *
 * Returns a list of human-readable error strings (empty when all keys are
 * valid). Used both at daemon startup (fail fast) and by `config lint`.
 *
 * @param providerKeys The keys configured under `inference.apiKeys`.
 * @param lookupProvider Provider-level metadata lookup.
 */
export async function validateConfiguredProviders(
    providerKeys: readonly string[],
    lookupProvider: ProviderMetaLookup,
): Promise<string[]> {
    const errors: string[] = [];
    for (const key of providerKeys) {
        const meta = await lookupProvider(key);
        if (meta?.npmPackage === undefined) {
            errors.push(
                `inference.apiKeys.${key}: not a known provider — it is not in the models.dev catalogue and no plugin declares it. Either rename it to a models.dev provider id, or install a plugin that provides it.`,
            );
            continue;
        }
        try {
            resolveUpstreamBase(meta.npmPackage, meta.apiEndpoint);
        } catch (err) {
            errors.push(
                `inference.apiKeys.${key}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
    return errors;
}
