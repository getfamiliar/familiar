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
