import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * Hardcoded model id for the initial smoke wiring. Llama 3.1 8B Instruct is
 * a small, fast, tool-call-capable model on Featherless's catalog — fine
 * for proving the pipe end-to-end. Will grow into per-role selection
 * (supervisor / triage / subagent) once we wire those up.
 */
const DEFAULT_MODEL_ID = "meta-llama/Meta-Llama-3.1-8B-Instruct";

/**
 * Builds the {@link LanguageModel} object the {@link AgentRunner} hands to
 * the Vercel AI SDK's tool-loop agent.
 *
 * The class is intentionally an empty namespace today; once we add per-role
 * model selection it will keep the same call sites working
 * (`ModelFactory.build()` for the supervisor, future
 * `ModelFactory.buildTriage()` etc.).
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Reserved as a growth point for per-role model selection.
export class ModelFactory {
    /**
     * Build the supervisor's language-model object. Reads
     * `FEATHERLESS_BASE_URL` and `FEATHERLESS_API_KEY` from the container
     * env (injected by the host daemon; the API key is a placeholder and
     * the real key only lives in the reverse proxy).
     *
     * @throws If either env var is unset.
     */
    static build(): LanguageModel {
        const baseURL = requireEnv("FEATHERLESS_BASE_URL");
        const apiKey = requireEnv("FEATHERLESS_API_KEY");
        const provider = createOpenAICompatible({
            name: "featherless",
            baseURL,
            apiKey,
        });
        return provider.chatModel(DEFAULT_MODEL_ID);
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
