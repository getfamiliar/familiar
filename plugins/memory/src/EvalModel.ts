import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { HostContext } from "@getfamiliar/shared";
import type { LanguageModel } from "ai";

/**
 * Builds the chat model for the eval's LLM stage. It talks to the provider directly (the CLI has
 * no agent container), with the key `ctx.inference.resolveProvider` reads from config — the same
 * route the plugin used for embeddings before.
 */

/** Aliases the shipped templates use; unset ones fall back to `inference.defaultModel`. */
const STANDARD_ALIASES = new Set(["fast", "smart"]);

/** A resolved model, with a label for the report. */
export interface EvalModel {
    /** The SDK model. */
    readonly model: LanguageModel;
    /** `<provider>/<modelId>`, plus the alias when one was used. */
    readonly label: string;
}

/**
 * Resolves a model ref (alias from `inference.aliases`, `<provider>/<modelId>` or bare id of the
 * default provider) like the container's `ModelFactory`, and builds it.
 *
 * @param ctx - Host context (config and provider resolution).
 * @param modelRef - The ref, e.g. `fast`.
 * @returns The model and its label.
 * @throws {Error} When the provider is unknown, has no key, or its SDK package is unsupported.
 */
export async function buildEvalModel(ctx: HostContext, modelRef: string): Promise<EvalModel> {
    const aliases = readAliases(ctx);
    const defaultModel = ctx.config.getString("inference.defaultModel");
    const defaultProvider =
        ctx.config.getString("inference.defaultProvider", null) ??
        ctx.config.getString("inference.provider");
    const requested =
        STANDARD_ALIASES.has(modelRef) && !Object.hasOwn(aliases, modelRef)
            ? defaultModel
            : modelRef;
    const alias = Object.hasOwn(aliases, requested) ? requested : undefined;
    const ref = alias === undefined ? requested : aliases[alias];

    let provider = defaultProvider;
    let modelId = ref;
    const slash = ref.indexOf("/");
    if (slash > 0 && (await ctx.inference.resolveProvider(ref.slice(0, slash)))) {
        provider = ref.slice(0, slash);
        modelId = ref.slice(slash + 1);
    }
    const resolved = await ctx.inference.resolveProvider(provider);
    if (!resolved) {
        throw new Error(
            `memory eval: provider "${provider}" (model ref "${modelRef}") has no API key under inference.apiKeys or is unknown`,
        );
    }
    const label = `${provider}/${modelId}${alias ? ` (alias ${alias})` : ""}`;
    if (resolved.npmPackage === "@ai-sdk/openai") {
        return {
            model: createOpenAI({ apiKey: resolved.apiKey, baseURL: resolved.apiEndpoint }).chat(
                modelId,
            ),
            label,
        };
    }
    if (resolved.apiEndpoint) {
        const client = createOpenAICompatible({
            name: provider,
            apiKey: resolved.apiKey,
            baseURL: resolved.apiEndpoint,
        });
        return { model: client.chatModel(modelId), label };
    }
    throw new Error(
        `memory eval: provider "${provider}" uses ${resolved.npmPackage} without an OpenAI-compatible endpoint — pick another model with --model`,
    );
}

/**
 * Reads `inference.aliases`.
 *
 * @param ctx - Host context.
 * @returns Alias → model ref; empty when unset or malformed.
 */
function readAliases(ctx: HostContext): Record<string, string> {
    const raw = ctx.config.getValue("inference.aliases");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {};
    }
    return Object.fromEntries(
        Object.entries(raw).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
    );
}
