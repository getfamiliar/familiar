/**
 * Catalogue of inference providers we ship with first-class Vercel AI
 * SDK classes on the container side. The id is the user-facing config
 * key (under `inference.apiKeys.<id>` in `config.yml`) and the URL
 * segment the reverse proxy mounts at `/llm/<id>/`. Every entry knows
 * its upstream base URL and how to inject the real API key into the
 * outgoing request — providers differ on that header (`Authorization:
 * Bearer` for most; `x-api-key` for Anthropic; `x-goog-api-key` for
 * Google).
 *
 * The container's `ModelFactory` keeps its own parallel mapping from
 * id → SDK package; the linter and proxy don't care which SDK class is
 * used, only that the id is in the whitelist.
 */

/**
 * How a provider authenticates upstream. The proxy calls `applyAuth`
 * after stripping inbound auth headers, so the only `Authorization` /
 * `x-api-key` / `x-goog-api-key` header reaching the upstream is the
 * one written by this function with the host-held key.
 */
export type AuthApplier = (headers: Record<string, string | string[]>, apiKey: string) => void;

/** Per-provider routing/auth config baked into the host. */
export interface NativeProviderSpec {
    /** Upstream base URL — appended after, no trailing slash needed. */
    readonly upstreamBase: string;
    /** Injects the configured api key under the right header name. */
    readonly applyAuth: AuthApplier;
}

const bearerAuth: AuthApplier = (headers, apiKey) => {
    headers.authorization = `Bearer ${apiKey}`;
};

const anthropicAuth: AuthApplier = (headers, apiKey) => {
    headers["x-api-key"] = apiKey;
    // Anthropic insists on a stable API version header — set a
    // recent default so callers that omit it (or strip it because
    // their SDK assumed direct connection) still get a valid call.
    if (headers["anthropic-version"] === undefined) {
        headers["anthropic-version"] = "2023-06-01";
    }
};

const googleAuth: AuthApplier = (headers, apiKey) => {
    headers["x-goog-api-key"] = apiKey;
};

/**
 * Whitelist of native providers. The id (map key) is the public name
 * used in `config.yml`, in `/llm/<id>/...` URLs, and as the prefix
 * handlers can put on `model` (e.g. `anthropic/claude-opus-4-7`).
 */
export const NATIVE_PROVIDERS: Readonly<Record<string, NativeProviderSpec>> = {
    // Each `upstreamBase` mirrors the `/v1` (or similar) prefix the
    // corresponding `@ai-sdk/<provider>` package carries in its default
    // baseURL. The container hands the SDK `http://bastion/llm/<id>`
    // as baseURL, which strips that prefix; the SDK then only appends
    // its endpoint-relative path (e.g. `/chat/completions`,
    // `/messages`). The bastion has to put the version segment back in
    // on the upstream side, otherwise the API returns a path-not-found
    // 404. `deepseek` and `google` don't follow the `/v1` convention —
    // their SDKs build the version into the per-request path instead,
    // so the bases stay unversioned.
    openai: {
        upstreamBase: "https://api.openai.com/v1",
        applyAuth: bearerAuth,
    },
    anthropic: {
        upstreamBase: "https://api.anthropic.com/v1",
        applyAuth: anthropicAuth,
    },
    google: {
        upstreamBase: "https://generativelanguage.googleapis.com",
        applyAuth: googleAuth,
    },
    grok: {
        upstreamBase: "https://api.x.ai/v1",
        applyAuth: bearerAuth,
    },
    groq: {
        upstreamBase: "https://api.groq.com/openai/v1",
        applyAuth: bearerAuth,
    },
    deepseek: {
        upstreamBase: "https://api.deepseek.com",
        applyAuth: bearerAuth,
    },
    mistral: {
        upstreamBase: "https://api.mistral.ai/v1",
        applyAuth: bearerAuth,
    },
};

/**
 * The set of provider ids that are reserved for native vendors. A
 * `customProviders.<id>` entry colliding with one of these is rejected
 * at lint time even when no `apiKeys.<id>` is set — so a Featherless-
 * style gateway can't be installed at e.g. `customProviders.anthropic`
 * and shadow the native Anthropic semantics later. The lint message
 * points the user at picking a different id.
 */
export const NATIVE_PROVIDER_IDS: ReadonlySet<string> = new Set(Object.keys(NATIVE_PROVIDERS));
