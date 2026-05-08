import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";

/**
 * Placeholder API key sent by every provider client. The real upstream
 * keys live only on the host (in the bastion's ReverseProxy), which
 * strips inbound auth headers and injects the right per-vendor header
 * with the real key. This value is not a secret — it grants no
 * upstream access on its own — so we hardcode it here rather than
 * routing it through env vars or config.
 */
const PLACEHOLDER_API_KEY = "via-bastion";

/**
 * Each enabled provider's `type` as declared by the host's
 * `INFERENCE_PROVIDERS` env. Native ids carry their own SDK class;
 * `openai-compatible` is the one custom type we ship today.
 */
type ProviderType =
    | "openai"
    | "anthropic"
    | "google"
    | "grok"
    | "groq"
    | "deepseek"
    | "mistral"
    | "openai-compatible";

/** Function that builds a {@link LanguageModel} for a given model id. */
type LanguageModelBuilder = (modelId: string) => LanguageModel;

/**
 * Build the per-provider Vercel AI SDK client and return a function
 * that turns a model id into a `LanguageModel`. The SDK provider
 * objects are themselves cheap (no sockets opened) but build them once
 * per id so repeat calls reuse the same configured client.
 */
function buildClient(
    providerId: string,
    type: ProviderType,
    baseURL: string,
): LanguageModelBuilder {
    switch (type) {
        case "openai": {
            const client = createOpenAI({ apiKey: PLACEHOLDER_API_KEY, baseURL });
            return (id) => client.languageModel(id);
        }
        case "anthropic": {
            const client = createAnthropic({ apiKey: PLACEHOLDER_API_KEY, baseURL });
            return (id) => client.languageModel(id);
        }
        case "google": {
            const client = createGoogleGenerativeAI({ apiKey: PLACEHOLDER_API_KEY, baseURL });
            return (id) => client.languageModel(id);
        }
        case "grok": {
            const client = createXai({ apiKey: PLACEHOLDER_API_KEY, baseURL });
            return (id) => client.languageModel(id);
        }
        case "groq": {
            const client = createGroq({ apiKey: PLACEHOLDER_API_KEY, baseURL });
            return (id) => client.languageModel(id);
        }
        case "deepseek": {
            const client = createDeepSeek({ apiKey: PLACEHOLDER_API_KEY, baseURL });
            return (id) => client.languageModel(id);
        }
        case "mistral": {
            const client = createMistral({ apiKey: PLACEHOLDER_API_KEY, baseURL });
            return (id) => client.languageModel(id);
        }
        case "openai-compatible": {
            const client = createOpenAICompatible({
                name: providerId,
                apiKey: PLACEHOLDER_API_KEY,
                baseURL,
            });
            return (id) => client.languageModel(id);
        }
    }
}

/** Resolved provider catalogue read once at module load. */
interface ProviderCatalogue {
    readonly bastionUrl: string;
    readonly defaultProvider: string;
    readonly defaultModel: string;
    readonly types: Readonly<Record<string, ProviderType>>;
}

let catalogue: ProviderCatalogue | undefined;
const builders = new Map<string, LanguageModelBuilder>();

/** Lazy load + parse `INFERENCE_*` env into a typed catalogue. */
function getCatalogue(): ProviderCatalogue {
    if (catalogue !== undefined) {
        return catalogue;
    }
    const bastionUrl = requireEnv("BASTION_URL").replace(/\/$/, "");
    const defaultProvider = requireEnv("INFERENCE_DEFAULT_PROVIDER");
    const defaultModel = requireEnv("INFERENCE_DEFAULT_MODEL");
    const rawProviders = requireEnv("INFERENCE_PROVIDERS");
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawProviders);
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`INFERENCE_PROVIDERS is not valid JSON: ${cause}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("INFERENCE_PROVIDERS must be a JSON object of {id: type}.");
    }
    const types: Record<string, ProviderType> = {};
    for (const [id, value] of Object.entries(parsed)) {
        if (typeof value !== "string" || !isProviderType(value)) {
            throw new Error(`INFERENCE_PROVIDERS.${id}: unsupported type "${String(value)}".`);
        }
        types[id] = value;
    }
    if (types[defaultProvider] === undefined) {
        throw new Error(
            `INFERENCE_DEFAULT_PROVIDER="${defaultProvider}" is not present in INFERENCE_PROVIDERS.`,
        );
    }
    catalogue = { bastionUrl, defaultProvider, defaultModel, types };
    return catalogue;
}

function isProviderType(value: string): value is ProviderType {
    return (
        value === "openai" ||
        value === "anthropic" ||
        value === "google" ||
        value === "grok" ||
        value === "groq" ||
        value === "deepseek" ||
        value === "mistral" ||
        value === "openai-compatible"
    );
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
        if (cat.types[head] !== undefined) {
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
    const type = cat.types[provider];
    if (type === undefined) {
        throw new Error(
            `model references provider "${provider}" but it is not enabled. ` +
                `Enabled providers: ${Object.keys(cat.types).join(", ") || "(none)"}.`,
        );
    }
    const baseURL = `${cat.bastionUrl}/llm/${provider}`;
    const built = buildClient(provider, type, baseURL);
    builders.set(provider, built);
    return built;
}

/**
 * Builds the {@link LanguageModel} object the {@link AgentRunner} hands
 * to the Vercel AI SDK's tool-loop agent.
 *
 * Resolves the handler-declared `model` ref against the host-supplied
 * provider catalogue (`INFERENCE_*` env). Bare ids like
 * `zai-org/GLM-5.1` map to the default provider; prefixed ids like
 * `openai/gpt-4o-mini` switch providers when the prefix matches an
 * enabled id.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: matches the existing call site shape; the per-id cache lives in a module-private map.
export class ModelFactory {
    /**
     * Build a chat language-model object for the requested model ref.
     *
     * @param modelRef Handler-declared model identifier — bare or
     *   `<provider>/<modelId>`. Falls back to defaults from
     *   `INFERENCE_DEFAULT_*` when undefined.
     * @throws If env is misconfigured or the provider in the prefix
     *   isn't enabled in `INFERENCE_PROVIDERS`.
     */
    static build(modelRef?: string): LanguageModel {
        const cat = getCatalogue();
        const { provider, modelId } = resolveModelRef(modelRef, cat);
        return builderFor(provider, cat)(modelId);
    }
}

/**
 * Read a required environment variable.
 *
 * @throws If the variable is unset or empty.
 */
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is not set in the agent container env.`);
    }
    return value;
}
