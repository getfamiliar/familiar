import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { type ProviderMetaLookup, validateConfiguredProviders } from "./ProviderResolution.js";

/** Stub provider-metadata lookup driven by a fixed table. */
function lookupFrom(
    table: Record<string, { npmPackage?: string; apiEndpoint?: string } | undefined>,
): ProviderMetaLookup {
    return async (key) => table[key];
}

describe("validateConfiguredProviders", () => {
    it("accepts a dedicated-package provider (no endpoint needed)", async () => {
        const errors = await validateConfiguredProviders(
            ["openai"],
            lookupFrom({ openai: { npmPackage: "@ai-sdk/openai" } }),
        );
        assert.deepEqual(errors, []);
    });

    it("accepts an openai-compatible provider that carries an endpoint", async () => {
        const errors = await validateConfiguredProviders(
            ["featherless"],
            lookupFrom({
                featherless: {
                    npmPackage: "@ai-sdk/openai-compatible",
                    apiEndpoint: "https://api.featherless.ai/v1",
                },
            }),
        );
        assert.deepEqual(errors, []);
    });

    it("flags a key that resolves to no known provider", async () => {
        const errors = await validateConfiguredProviders(
            ["bogus"],
            lookupFrom({ bogus: undefined }),
        );
        assert.equal(errors.length, 1);
        assert.match(errors[0], /not a known provider/);
    });

    it("flags an unsupported npm package", async () => {
        const errors = await validateConfiguredProviders(
            ["weird"],
            lookupFrom({ weird: { npmPackage: "@ai-sdk/cohere" } }),
        );
        assert.equal(errors.length, 1);
        assert.match(errors[0], /unsupported npm package/);
    });

    it("flags an openai-compatible provider with no endpoint", async () => {
        const errors = await validateConfiguredProviders(
            ["gw"],
            lookupFrom({ gw: { npmPackage: "@ai-sdk/openai-compatible" } }),
        );
        assert.equal(errors.length, 1);
        assert.match(errors[0], /no default base URL/);
    });
});
