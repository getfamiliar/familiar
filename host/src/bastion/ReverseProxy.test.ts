import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildProviders } from "./ReverseProxy.js";

describe("buildProviders", () => {
    it("maps known native providers to their built-in upstream URLs and auth headers", () => {
        const providers = buildProviders({ openai: "okey", anthropic: "akey" }, {});
        assert.equal(providers.openai?.upstreamBase, "https://api.openai.com");
        assert.equal(providers.anthropic?.upstreamBase, "https://api.anthropic.com");

        const openaiHeaders: Record<string, string | string[]> = {};
        providers.openai?.applyAuth(openaiHeaders);
        assert.equal(openaiHeaders.authorization, "Bearer okey");

        const anthropicHeaders: Record<string, string | string[]> = {};
        providers.anthropic?.applyAuth(anthropicHeaders);
        assert.equal(anthropicHeaders["x-api-key"], "akey");
        assert.equal(anthropicHeaders["anthropic-version"], "2023-06-01");
    });

    it("registers a custom provider with its declared baseUrl + apiKey + bearer auth", () => {
        const providers = buildProviders(
            {},
            {
                featherless: {
                    baseUrl: "https://api.featherless.ai",
                    apiKey: "fkey",
                    type: "openai-compatible",
                },
            },
        );
        assert.equal(providers.featherless?.upstreamBase, "https://api.featherless.ai");
        const headers: Record<string, string | string[]> = {};
        providers.featherless?.applyAuth(headers);
        assert.equal(headers.authorization, "Bearer fkey");
    });

    it("strips a trailing slash from a custom provider baseUrl", () => {
        const providers = buildProviders(
            {},
            {
                gateway: {
                    baseUrl: "https://api.example.com/",
                    apiKey: "k",
                    type: "openai-compatible",
                },
            },
        );
        assert.equal(providers.gateway?.upstreamBase, "https://api.example.com");
    });

    it("throws when a native api key is empty or non-string", () => {
        assert.throws(() => buildProviders({ openai: "" }, {}), /must be a non-empty string/);
        assert.throws(() => buildProviders({ openai: 42 }, {}), /must be a non-empty string/);
    });

    it("throws when an apiKeys id is not a known native provider", () => {
        assert.throws(
            () => buildProviders({ unknownprovider: "key" }, {}),
            /unknownprovider is not a known native provider/,
        );
    });

    it("rejects a custom provider whose id collides with a native one", () => {
        assert.throws(
            () =>
                buildProviders(
                    {},
                    {
                        anthropic: {
                            baseUrl: "https://example.com",
                            apiKey: "k",
                            type: "openai-compatible",
                        },
                    },
                ),
            /id is reserved for the native provider/,
        );
    });

    it("rejects a custom provider with a non-https baseUrl", () => {
        assert.throws(
            () =>
                buildProviders(
                    {},
                    {
                        bad: {
                            baseUrl: "http://insecure.example.com",
                            apiKey: "k",
                            type: "openai-compatible",
                        },
                    },
                ),
            /baseUrl: must be an https URL/,
        );
    });

    it('rejects a custom provider whose type is not "openai-compatible"', () => {
        assert.throws(
            () =>
                buildProviders(
                    {},
                    {
                        weird: {
                            baseUrl: "https://example.com",
                            apiKey: "k",
                            type: "something-else",
                        },
                    },
                ),
            /only "openai-compatible" is supported/,
        );
    });

    it("returns an empty map when nothing is configured", () => {
        assert.deepEqual(buildProviders({}, {}), {});
    });
});
