import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ResolvedProvider } from "../models/ProviderResolution.js";
import { buildProviders } from "./ReverseProxy.js";

describe("buildProviders", () => {
    it("maps providers to upstream URLs + auth from their npm package", () => {
        const providers = buildProviders([
            { key: "openai", apiKey: "okey", npmPackage: "@ai-sdk/openai" },
            { key: "anthropic", apiKey: "akey", npmPackage: "@ai-sdk/anthropic" },
        ]);
        assert.equal(providers.openai?.upstreamBase, "https://api.openai.com/v1");
        assert.equal(providers.anthropic?.upstreamBase, "https://api.anthropic.com/v1");

        const openaiHeaders: Record<string, string | string[]> = {};
        providers.openai?.applyAuth(openaiHeaders);
        assert.equal(openaiHeaders.authorization, "Bearer okey");

        const anthropicHeaders: Record<string, string | string[]> = {};
        providers.anthropic?.applyAuth(anthropicHeaders);
        assert.equal(anthropicHeaders["x-api-key"], "akey");
        assert.equal(anthropicHeaders["anthropic-version"], "2023-06-01");
    });

    it("uses the explicit apiEndpoint for an openai-compatible provider", () => {
        const providers = buildProviders([
            {
                key: "featherless",
                apiKey: "fkey",
                npmPackage: "@ai-sdk/openai-compatible",
                apiEndpoint: "https://api.featherless.ai/v1",
            },
        ]);
        assert.equal(providers.featherless?.upstreamBase, "https://api.featherless.ai/v1");
        const headers: Record<string, string | string[]> = {};
        providers.featherless?.applyAuth(headers);
        assert.equal(headers.authorization, "Bearer fkey");
    });

    it("strips a trailing slash from the resolved upstream base", () => {
        const providers = buildProviders([
            {
                key: "gateway",
                apiKey: "k",
                npmPackage: "@ai-sdk/openai-compatible",
                apiEndpoint: "https://api.example.com/",
            },
        ]);
        assert.equal(providers.gateway?.upstreamBase, "https://api.example.com");
    });

    it("throws for an unsupported npm package", () => {
        assert.throws(
            () => buildProviders([{ key: "x", apiKey: "k", npmPackage: "@ai-sdk/cohere" }]),
            /unsupported npm package/,
        );
    });

    it("throws for an openai-compatible provider with no apiEndpoint", () => {
        assert.throws(
            () =>
                buildProviders([
                    { key: "x", apiKey: "k", npmPackage: "@ai-sdk/openai-compatible" },
                ]),
            /has no default base URL/,
        );
    });

    it("returns an empty map when nothing is configured", () => {
        assert.deepEqual(buildProviders([] as ResolvedProvider[]), {});
    });
});
