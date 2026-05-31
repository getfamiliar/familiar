import { strict as assert } from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";
import type { Logger } from "@getfamiliar/shared";
import { ModelMetadataService } from "./ModelMetadataService.js";

/** 24 hours in milliseconds — the staleness window the daemon uses. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Project `tmp/` dir — reuse the same cache file the daemon maintains. */
const TMP_DIR = path.join(import.meta.dirname, "..", "..", "..", "tmp");

/** Discards all output; these are integration tests, not log assertions. */
const silentLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => silentLog,
} as unknown as Logger;

/**
 * A few model ids that have been around long enough to remain in
 * models.dev for the foreseeable future. Assertions are structural, so
 * if one is eventually retired the suite skips rather than fails.
 */
const CLASSIC_MODELS: ReadonlyArray<{ provider: string; model: string }> = [
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "deepseek", model: "deepseek-chat" },
    { provider: "anthropic", model: "claude-3-5-haiku-20241022" },
];

function makeService(): ModelMetadataService {
    return new ModelMetadataService({
        tmpDir: TMP_DIR,
        // No plugin fallback in this suite — models.dev only.
        lookupPluginMeta: async () => undefined,
        // One synthetic plugin provider to exercise the descriptor path.
        listPluginProviders: () => [
            {
                key: "test-gateway",
                npmPackage: "@ai-sdk/openai-compatible",
                apiEndpoint: "https://gateway.example/v1",
            },
        ],
        log: silentLog,
    });
}

describe("ModelMetadataService (models.dev, live)", () => {
    it("resolves structural metadata for classic models", async (t) => {
        const service = makeService();
        // Reuses tmp/models.json when fresh; only fetches when missing
        // or older than 24h — keeps repeat same-day runs fast.
        await service.refreshIfStale(ONE_DAY_MS);

        const resolved = await Promise.all(
            CLASSIC_MODELS.map(async ({ provider, model }) => ({
                provider,
                model,
                meta: await service.lookup(provider, model),
            })),
        );
        const found = resolved.filter((r) => r.meta !== undefined);

        if (found.length === 0) {
            t.skip("models.dev catalogue unavailable (offline and no cache)");
            return;
        }

        for (const { meta } of found) {
            assert.ok(meta, "metadata present");
            assert.equal(typeof meta.contextLimit, "number");
            assert.ok((meta.contextLimit ?? 0) > 0, "positive context limit");
            assert.equal(typeof meta.toolCall, "boolean");
        }
    });

    it("returns undefined for an unknown model (no plugin fallback)", async (t) => {
        const service = makeService();
        await service.refreshIfStale(ONE_DAY_MS);

        // Guard: only meaningful when the catalogue actually loaded.
        const probe = await service.lookup("openai", "gpt-4o-mini");
        if (probe === undefined) {
            t.skip("models.dev catalogue unavailable (offline and no cache)");
            return;
        }

        const meta = await service.lookup("openai", "definitely-not-a-real-model-xyz");
        assert.equal(meta, undefined);
    });
});

describe("ModelMetadataService.lookupProvider", () => {
    it("resolves provider-level npm + endpoint from models.dev", async (t) => {
        const service = makeService();
        await service.refreshIfStale(ONE_DAY_MS);

        const openai = await service.lookupProvider("openai");
        if (openai === undefined) {
            t.skip("models.dev catalogue unavailable (offline and no cache)");
            return;
        }
        // Dedicated-package provider: npm present, no endpoint in models.dev.
        assert.equal(openai.npmPackage, "@ai-sdk/openai");
        assert.equal(openai.apiEndpoint, undefined);

        // openai-compatible gateway carried by models.dev: endpoint present.
        const deepseek = await service.lookupProvider("deepseek");
        assert.equal(deepseek?.npmPackage, "@ai-sdk/openai-compatible");
        assert.ok(
            (deepseek?.apiEndpoint ?? "").startsWith("https://"),
            "deepseek carries an https endpoint",
        );
    });

    it("falls back to a plugin descriptor for a non-models.dev provider", async () => {
        const service = makeService();
        const meta = await service.lookupProvider("test-gateway");
        assert.deepEqual(meta, {
            npmPackage: "@ai-sdk/openai-compatible",
            apiEndpoint: "https://gateway.example/v1",
        });
    });

    it("returns undefined for an unknown provider", async () => {
        const service = makeService();
        const meta = await service.lookupProvider("totally-unknown-provider-xyz");
        assert.equal(meta, undefined);
    });
});
