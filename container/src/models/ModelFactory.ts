import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import { requireConfig } from "../utils/PassedConfig.js";

/**
 * Placeholder API key sent by every provider client. The real upstream
 * keys live only on the host (in the bastion's ReverseProxy), which
 * strips inbound auth headers and injects the right per-vendor header
 * with the real key. This value is not a secret — it grants no
 * upstream access on its own — so we hardcode it here rather than
 * routing it through env vars or config.
 */
const PLACEHOLDER_API_KEY = "via-bastion";

/** Function that builds a {@link LanguageModel} for a given model id. */
type LanguageModelBuilder = (modelId: string) => LanguageModel;

/**
 * Map of supported Vercel AI SDK npm package → a factory that builds
 * the configured SDK client and returns a per-id model builder. The
 * provider's npm package (from model metadata: models.dev `npm` or a
 * plugin descriptor) is what selects the `create*` function — there is
 * no per-provider `type` switch anymore.
 *
 * The host keeps a parallel npm→{auth, default base} map
 * (`NpmProviderProfiles.ts`); **the set of supported npm packages must
 * stay in sync between the two.** `@ai-sdk/openai-compatible` needs the
 * provider id as its `name`, so every factory takes `(providerId,
 * baseURL)`.
 */
const NPM_MODEL_BUILDERS: Readonly<
    Record<string, (providerId: string, baseURL: string) => LanguageModelBuilder>
> = {
    "@ai-sdk/openai": (_id, baseURL) => {
        const client = createOpenAI({ apiKey: PLACEHOLDER_API_KEY, baseURL });
        return (id) => client.languageModel(id);
    },
    "@ai-sdk/anthropic": (_id, baseURL) => {
        const client = createAnthropic({ apiKey: PLACEHOLDER_API_KEY, baseURL });
        return (id) => client.languageModel(id);
    },
    "@ai-sdk/google": (_id, baseURL) => {
        const client = createGoogleGenerativeAI({ apiKey: PLACEHOLDER_API_KEY, baseURL });
        return (id) => client.languageModel(id);
    },
    "@ai-sdk/groq": (_id, baseURL) => {
        const client = createGroq({ apiKey: PLACEHOLDER_API_KEY, baseURL });
        return (id) => client.languageModel(id);
    },
    "@ai-sdk/mistral": (_id, baseURL) => {
        const client = createMistral({ apiKey: PLACEHOLDER_API_KEY, baseURL });
        return (id) => client.languageModel(id);
    },
    "@ai-sdk/xai": (_id, baseURL) => {
        const client = createXai({ apiKey: PLACEHOLDER_API_KEY, baseURL });
        return (id) => client.languageModel(id);
    },
    "@ai-sdk/deepseek": (_id, baseURL) => {
        const client = createDeepSeek({ apiKey: PLACEHOLDER_API_KEY, baseURL });
        return (id) => client.languageModel(id);
    },
    "@ai-sdk/openai-compatible": (providerId, baseURL) => {
        const client = createOpenAICompatible({
            name: providerId,
            apiKey: PLACEHOLDER_API_KEY,
            baseURL,
        });
        return (id) => client.languageModel(id);
    },
};

/** Resolved provider catalogue read once at module load. */
interface ProviderCatalogue {
    readonly bastionUrl: string;
    readonly defaultProvider: string;
    readonly defaultModel: string;
    /** Provider key → its npm package (passed config `inference.providers`). */
    readonly npmPackages: Readonly<Record<string, string>>;
}

let catalogue: ProviderCatalogue | undefined;
const builders = new Map<string, LanguageModelBuilder>();

/** Lazy read of the `inference.*` passed config into a typed catalogue. */
function getCatalogue(): ProviderCatalogue {
    if (catalogue !== undefined) {
        return catalogue;
    }
    const bastionUrl = requireConfig<string>("bastionUrl").replace(/\/$/, "");
    const defaultProvider = requireConfig<string>("inference.defaultProvider");
    const defaultModel = requireConfig<string>("inference.defaultModel");
    const providers = requireConfig<Record<string, unknown>>("inference.providers");
    const npmPackages: Record<string, string> = {};
    for (const [id, value] of Object.entries(providers)) {
        if (typeof value !== "string" || NPM_MODEL_BUILDERS[value] === undefined) {
            const supported = Object.keys(NPM_MODEL_BUILDERS).join(", ");
            throw new Error(
                `inference.providers.${id}: unsupported npm package "${String(value)}" (supported: ${supported}).`,
            );
        }
        npmPackages[id] = value;
    }
    if (npmPackages[defaultProvider] === undefined) {
        throw new Error(
            `inference.defaultProvider="${defaultProvider}" is not present in inference.providers.`,
        );
    }
    catalogue = { bastionUrl, defaultProvider, defaultModel, npmPackages };
    return catalogue;
}

/** Resolve a handler-declared `model` ref into `(provider, modelId)`. */
function resolveModelRef(
    modelRef: string | undefined,
    cat: ProviderCatalogue,
): { provider: string; modelId: string } {
    if (modelRef === undefined || modelRef.length === 0) {
        return { provider: cat.defaultProvider, modelId: cat.defaultModel };
    }
    const slashIdx = modelRef.indexOf("/");
    if (slashIdx > 0) {
        const head = modelRef.slice(0, slashIdx);
        if (cat.npmPackages[head] !== undefined) {
            return { provider: head, modelId: modelRef.slice(slashIdx + 1) };
        }
    }
    return { provider: cat.defaultProvider, modelId: modelRef };
}

/** Lazily fetch (and cache) the SDK builder for a provider id. */
function builderFor(provider: string, cat: ProviderCatalogue): LanguageModelBuilder {
    const cached = builders.get(provider);
    if (cached !== undefined) {
        return cached;
    }
    const npmPackage = cat.npmPackages[provider];
    if (npmPackage === undefined) {
        throw new Error(
            `model references provider "${provider}" but it is not enabled. ` +
                `Enabled providers: ${Object.keys(cat.npmPackages).join(", ") || "(none)"}.`,
        );
    }
    const factory = NPM_MODEL_BUILDERS[npmPackage];
    if (factory === undefined) {
        const supported = Object.keys(NPM_MODEL_BUILDERS).join(", ");
        throw new Error(
            `provider "${provider}" uses unsupported npm package "${npmPackage}" (supported: ${supported}).`,
        );
    }
    const baseURL = `${cat.bastionUrl}/llm/${provider}`;
    const built = factory(provider, baseURL);
    builders.set(provider, built);
    return built;
}

/**
 * Builds the {@link LanguageModel} object the {@link AgentRunner} hands
 * to the Vercel AI SDK's tool-loop agent.
 *
 * Resolves the handler-declared `model` ref against the host-supplied
 * provider catalogue (the `inference.*` passed config). Bare ids like
 * `zai-org/GLM-5.1` map to the default provider; prefixed ids like
 * `openai/gpt-4o-mini` switch providers when the prefix matches an
 * enabled id. The provider's npm package (carried in
 * `inference.providers`) selects which `create*` SDK function is used.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: matches the existing call site shape; the per-id cache lives in a module-private map.
export class ModelFactory {
    /**
     * Build a chat language-model object for the requested model ref.
     * Returns the constructed `LanguageModel`, a `label` of the form
     * `<provider>/<modelId>`, and the resolved `provider` / `modelId`
     * pair separately — the provider prefix is filled in even when the
     * handler declared it bare. Callers persist the label on
     * `agentruns.model` for traceability, and use the resolved pair to
     * look the model's metadata up (see {@link
     * import("./ModelMetadataClient.js").fetchModelMetaData}).
     *
     * @param modelRef Handler-declared model identifier — bare or
     *   `<provider>/<modelId>`. Falls back to the passed config
     *   `inference.defaultProvider` / `inference.defaultModel` when undefined.
     * @throws If the passed config is misconfigured, the provider in the
     *   prefix isn't enabled in `inference.providers`, or its npm package is
     *   unsupported.
     */
    static build(modelRef?: string): {
        model: LanguageModel;
        label: string;
        provider: string;
        modelId: string;
    } {
        const cat = getCatalogue();
        const { provider, modelId } = resolveModelRef(modelRef, cat);
        return {
            model: builderFor(provider, cat)(modelId),
            label: `${provider}/${modelId}`,
            provider,
            modelId,
        };
    }
}
