import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * Fallback model id used when a handler file does not declare one in
 * its YAML header.
 */
const DEFAULT_MODEL_ID = "zai-org/GLM-5.1";

/**
 * Builds the {@link LanguageModel} object the {@link AgentRunner} hands
 * to the Vercel AI SDK's tool-loop agent.
 *
 * Today every call rebuilds the provider + chat-model wrapper. That is
 * cheap (no sockets opened, just config), but if many agentruns share a
 * model id this is the natural place to grow a per-id cache.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Reserved as a growth point for per-id caching.
export class ModelFactory {
    /**
     * Build a chat language-model object for the requested model id.
     *
     * Reads `BASTION_URL`, `INFERENCE_PROVIDER`, and `INFERENCE_API_KEY`
     * from the container env (injected by the host daemon). The base
     * URL is composed as `${BASTION_URL}/llm/${INFERENCE_PROVIDER}/v1`
     * so the host-side bastion's `/llm/<provider>/v1/*` route handles
     * the request and injects the real upstream key. The api key in
     * the container is a placeholder — the bastion strips it.
     *
     * @param modelId Provider-specific model id from the handler's YAML
     *   header. Falls back to {@link DEFAULT_MODEL_ID} when undefined.
     * @throws If any of the three env vars is unset.
     */
    static build(modelId?: string): LanguageModel {
        const bastionUrl = requireEnv("BASTION_URL");
        const provider = requireEnv("INFERENCE_PROVIDER");
        const apiKey = requireEnv("INFERENCE_API_KEY");
        const baseURL = `${bastionUrl.replace(/\/$/, "")}/llm/${provider}/v1`;
        const compat = createOpenAICompatible({
            name: provider,
            baseURL,
            apiKey,
        });
        return compat.chatModel(modelId ?? DEFAULT_MODEL_ID);
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
