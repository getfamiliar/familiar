/**
 * Per-npm-package routing/auth knowledge the host needs to proxy a
 * provider's inference calls. Keyed by the Vercel AI SDK npm package
 * (the `npm` field models.dev reports for a provider, or a plugin
 * descriptor's `npmPackage`) rather than by provider id — so a provider
 * is described by its *metadata*, not a baked-in per-provider table.
 *
 * Two facts can't come from model metadata and so live here:
 *
 *  - **auth style** — how the real API key is injected upstream
 *    (`Authorization: Bearer` for most; `x-api-key` for Anthropic;
 *    `x-goog-api-key` for Google). This is a property of the SDK
 *    package, not of any model.
 *  - **default base URL** — models.dev omits the provider-level `api`
 *    field for most first-party providers (only the openai-compatible
 *    gateways like deepseek carry one), but the SDK package knows its
 *    own default base. The resolver uses the metadata `apiEndpoint` when
 *    present and falls back to {@link NpmProviderProfile.defaultBase}.
 *
 * The container's `ModelFactory` keeps a parallel npm→`create*` map; the
 * **set of supported npm packages must stay in sync between the two**.
 */

/**
 * How a provider authenticates upstream. The proxy calls `applyAuth`
 * after stripping inbound auth headers, so the only `Authorization` /
 * `x-api-key` / `x-goog-api-key` header reaching the upstream is the
 * one written by this function with the host-held key.
 */
export type AuthApplier = (headers: Record<string, string | string[]>, apiKey: string) => void;

/** Per-npm-package routing/auth config baked into the host. */
export interface NpmProviderProfile {
    /**
     * Upstream base URL the SDK package targets by default, no trailing
     * slash. `undefined` for `@ai-sdk/openai-compatible`, which has no
     * single upstream — those providers must supply an `apiEndpoint` via
     * models.dev or a plugin descriptor.
     */
    readonly defaultBase?: string;
    /** Injects the configured api key under the right header name. */
    readonly applyAuth: AuthApplier;
}

const bearerAuth: AuthApplier = (headers, apiKey) => {
    headers.authorization = `Bearer ${apiKey}`;
};

const anthropicAuth: AuthApplier = (headers, apiKey) => {
    headers["x-api-key"] = apiKey;
    // Anthropic insists on a stable API version header — set a recent
    // default so callers that omit it (or strip it because their SDK
    // assumed a direct connection) still get a valid call.
    if (headers["anthropic-version"] === undefined) {
        headers["anthropic-version"] = "2023-06-01";
    }
};

const googleAuth: AuthApplier = (headers, apiKey) => {
    headers["x-goog-api-key"] = apiKey;
};

/**
 * Supported npm packages → their default upstream base + auth style.
 * The base URLs are carried over verbatim from the previous
 * provider-keyed `NATIVE_PROVIDERS` table: each mirrors the `/v1` (or
 * similar) prefix the corresponding `@ai-sdk/<provider>` package builds
 * into its default baseURL. The container hands the SDK
 * `http://bastion/llm/<key>` as baseURL (which strips that prefix); the
 * proxy puts the version segment back on the upstream side. `deepseek`
 * and `google` don't follow the `/v1` convention — their SDKs build the
 * version into the per-request path — so those bases stay unversioned.
 */
export const NPM_PROVIDER_PROFILES: Readonly<Record<string, NpmProviderProfile>> = {
    "@ai-sdk/openai": { defaultBase: "https://api.openai.com/v1", applyAuth: bearerAuth },
    "@ai-sdk/anthropic": { defaultBase: "https://api.anthropic.com/v1", applyAuth: anthropicAuth },
    "@ai-sdk/google": {
        defaultBase: "https://generativelanguage.googleapis.com",
        applyAuth: googleAuth,
    },
    "@ai-sdk/groq": { defaultBase: "https://api.groq.com/openai/v1", applyAuth: bearerAuth },
    "@ai-sdk/mistral": { defaultBase: "https://api.mistral.ai/v1", applyAuth: bearerAuth },
    "@ai-sdk/xai": { defaultBase: "https://api.x.ai/v1", applyAuth: bearerAuth },
    "@ai-sdk/deepseek": { defaultBase: "https://api.deepseek.com", applyAuth: bearerAuth },
    // openai-compatible gateways carry no single upstream — the resolved
    // provider must supply an apiEndpoint (from models.dev `api` or a
    // plugin descriptor). Bearer auth covers the OpenAI-style header.
    "@ai-sdk/openai-compatible": { applyAuth: bearerAuth },
};

/**
 * Resolve the upstream base URL the reverse proxy forwards to for a
 * provider, from its npm package + optional metadata `apiEndpoint`:
 * the explicit endpoint wins, otherwise the npm package's built-in
 * default base. The single gate both `buildProviders` (hot path) and
 * `validateConfiguredProviders` (lint/startup) call, so the supported-
 * npm and missing-endpoint rules are stated once.
 *
 * @throws If `npmPackage` isn't in {@link NPM_PROVIDER_PROFILES}, or it
 *   has no default base and no `apiEndpoint` was supplied.
 */
export function resolveUpstreamBase(npmPackage: string, apiEndpoint?: string): string {
    const profile = NPM_PROVIDER_PROFILES[npmPackage];
    if (profile === undefined) {
        const supported = Object.keys(NPM_PROVIDER_PROFILES).join(", ");
        throw new Error(`unsupported npm package "${npmPackage}" (supported: ${supported})`);
    }
    const base = apiEndpoint ?? profile.defaultBase;
    if (base === undefined || base.length === 0) {
        throw new Error(
            `npm package "${npmPackage}" has no default base URL — the provider must supply an apiEndpoint (models.dev "api" field or a plugin descriptor)`,
        );
    }
    return base.replace(/\/$/, "");
}
