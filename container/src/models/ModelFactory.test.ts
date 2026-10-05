import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { type ProviderCatalogue, resolveModelRef } from "./ModelFactory.js";

const catalogue: ProviderCatalogue = {
    bastionUrl: "http://bastion",
    bastionToken: "tok",
    defaultProvider: "featherless",
    defaultModel: "workhorse",
    npmPackages: {
        featherless: "@ai-sdk/openai-compatible",
        openai: "@ai-sdk/openai",
    },
    aliases: {
        fast: "deepseek-ai/DeepSeek-V4-Flash",
        workhorse: "zai-org/GLM-5.1",
        smart: "openai/gpt-5",
    },
};

describe("resolveModelRef — aliases", () => {
    it("resolves an alias to a bare model id under the default provider", () => {
        assert.deepEqual(resolveModelRef("fast", catalogue), {
            provider: "featherless",
            modelId: "deepseek-ai/DeepSeek-V4-Flash",
            alias: "fast",
        });
    });

    it("resolves an alias to a provider-prefixed model ref", () => {
        assert.deepEqual(resolveModelRef("smart", catalogue), {
            provider: "openai",
            modelId: "gpt-5",
            alias: "smart",
        });
    });

    it("resolves an alias used as defaultModel when the handler omits model", () => {
        assert.deepEqual(resolveModelRef(undefined, catalogue), {
            provider: "featherless",
            modelId: "zai-org/GLM-5.1",
            alias: "workhorse",
        });
        assert.deepEqual(resolveModelRef("", catalogue), resolveModelRef(undefined, catalogue));
    });

    it("passes an unknown name through as a bare model id", () => {
        assert.deepEqual(resolveModelRef("speedy", catalogue), {
            provider: "featherless",
            modelId: "speedy",
            alias: undefined,
        });
    });

    it("leaves non-alias refs unaffected", () => {
        assert.deepEqual(resolveModelRef("openai/gpt-4o-mini", catalogue), {
            provider: "openai",
            modelId: "gpt-4o-mini",
            alias: undefined,
        });
        assert.deepEqual(resolveModelRef("zai-org/GLM-5.1", catalogue), {
            provider: "featherless",
            modelId: "zai-org/GLM-5.1",
            alias: undefined,
        });
    });

    it("does not resolve inherited object keys as aliases", () => {
        assert.equal(resolveModelRef("toString", catalogue).alias, undefined);
    });
});
