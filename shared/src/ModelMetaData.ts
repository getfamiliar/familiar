/**
 * Capability metadata for a single inference model, normalized across
 * every source that can supply it (the models.dev database baked into
 * the host, or a plugin's {@link PluginHostManifest.getModelMetaData}
 * hook). Every field is optional because no single source fills them
 * all — featherless, for instance, exposes no `reasoning` flag, while
 * models.dev carries `npm` / `api` at the provider level rather than
 * per model.
 *
 * The host assembles this shape and the container fetches it (through
 * the bastion's `/model-metadata/` gateway) when an agentrun starts, so
 * downstream code can reason about the running model's limits and
 * capabilities.
 */
export interface ModelMetaData {
    /** npm package backing the model's SDK, e.g. `@ai-sdk/openai-compatible`. */
    npmPackage?: string;
    /** Upstream API base URL, e.g. `https://api.featherless.ai/v1`. */
    apiEndpoint?: string;
    /** Whether the model supports tool / function calling. */
    toolCall?: boolean;
    /** Whether the model is a reasoning model. */
    reasoning?: boolean;
    /** Maximum context window, in tokens. */
    contextLimit?: number;
    /** Maximum output length, in tokens. */
    outputLimit?: number;
}

/**
 * Provider-level descriptor a plugin returns from
 * {@link PluginHostManifest.getModelProviders} to declare an inference
 * provider it owns (one the models.dev database doesn't cover). The host
 * uses it to wire the reverse proxy (auth + upstream base) and the
 * container's model factory (which `create*` to call), keyed off
 * {@link npmPackage}.
 */
export interface ModelProviderDescriptor {
    /**
     * Provider key — the id used under `inference.apiKeys.<key>`, in
     * `/llm/<key>/` proxy routes, and as the `model` prefix. Matches a
     * models.dev provider id only when the plugin intentionally overrides
     * one; otherwise it's a plugin-owned id like `featherless`.
     */
    readonly key: string;
    /** npm package backing the provider's SDK, e.g. `@ai-sdk/openai-compatible`. */
    readonly npmPackage: string;
    /**
     * Upstream API base URL the reverse proxy forwards to, e.g.
     * `https://api.featherless.ai/v1`. Required for openai-compatible
     * providers (no SDK default exists); for a provider whose npm package
     * carries a built-in default base it may be omitted.
     */
    readonly apiEndpoint?: string;
}

/**
 * Thrown by a {@link PluginHostManifest.getModelMetaData} hook when the
 * plugin authoritatively owns the given provider and knows the model is
 * not supported there. The host treats this as a definitive "no" and
 * stops the lookup rather than consulting further plugins.
 */
export class ModelNotSupported extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ModelNotSupported";
    }
}
