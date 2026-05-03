import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * Fallback model id used when a handler file does not declare one in
 * its YAML header. Llama 3.1 8B Instruct is small, fast, and
 * tool-call-capable on Featherless's catalog — fine for handlers that
 * don't care.
 */
const DEFAULT_MODEL_ID = "meta-llama/Meta-Llama-3.1-8B-Instruct";

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
     * Build a chat language-model object for the requested provider id.
     * Reads `FEATHERLESS_BASE_URL` and `FEATHERLESS_API_KEY` from the
     * container env (injected by the host daemon; the API key is a
     * placeholder and the real key only lives in the reverse proxy).
     *
     * @param modelId Provider-specific model id from the handler's YAML
     *   header. Falls back to {@link DEFAULT_MODEL_ID} when undefined.
     * @throws If either env var is unset.
     */
    static build(modelId?: string): LanguageModel {
        const baseURL = requireEnv("FEATHERLESS_BASE_URL");
        const apiKey = requireEnv("FEATHERLESS_API_KEY");
        const provider = createOpenAICompatible({
            name: "featherless",
            baseURL,
            apiKey,
        });
        return provider.chatModel(modelId ?? DEFAULT_MODEL_ID);
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
