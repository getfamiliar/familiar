import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildProviders } from "./ReverseProxy.js";

describe("buildProviders", () => {
    it("maps known providers to their built-in upstream URLs", () => {
        const providers = buildProviders({ featherless: "fkey", openai: "okey" }, {});
        assert.equal(providers.featherless?.upstreamBase, "https://api.featherless.ai");
        assert.equal(providers.openai?.upstreamBase, "https://api.openai.com");
        assert.equal(providers.featherless?.upstreamApiKey, "fkey");
        assert.equal(providers.openai?.upstreamApiKey, "okey");
    });

    it("respects per-provider baseUrl overrides", () => {
        const providers = buildProviders(
            { featherless: "fkey" },
            { featherless: "https://custom.example.com" },
        );
        assert.equal(providers.featherless?.upstreamBase, "https://custom.example.com");
    });

    it("throws when an api key is empty or non-string", () => {
        assert.throws(() => buildProviders({ featherless: "" }, {}), /must be a non-empty string/);
        assert.throws(() => buildProviders({ featherless: 42 }, {}), /must be a non-empty string/);
    });

    it("throws on an unknown provider with no override", () => {
        assert.throws(
            () => buildProviders({ unknownprovider: "key" }, {}),
            /unknownprovider is not a known provider/,
        );
    });

    it("accepts an unknown provider when its baseUrl is overridden", () => {
        const providers = buildProviders(
            { unknownprovider: "key" },
            { unknownprovider: "https://api.example.com" },
        );
        assert.equal(providers.unknownprovider?.upstreamBase, "https://api.example.com");
    });

    it("returns an empty map when no api keys are configured", () => {
        assert.deepEqual(buildProviders({}, {}), {});
    });
});
