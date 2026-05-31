import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { type HostContext, type Logger, ModelNotSupported } from "@getfamiliar/shared";
import { parse as parseYaml } from "yaml";
import { FEATHERLESS_PROVIDER, FeatherlessModels } from "./FeatherlessModels.js";
import featherlessPlugin from "./index.js";

/** 24 hours in milliseconds — the staleness window the plugin uses. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Project root, two dirs up from `plugins/featherless/`. */
const PROJECT_ROOT = path.join(import.meta.dirname, "..", "..", "..");
const TMP_DIR = path.join(PROJECT_ROOT, "tmp");
const CACHE_FILE = path.join(TMP_DIR, "models.featherless.json");
const CONFIG_FILE = path.join(PROJECT_ROOT, "config", "config.yml");

const silentLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => silentLog,
} as unknown as Logger;

/**
 * Read the Featherless API key from `config/config.yml`, or `null` when
 * the file or key is absent (the suite then skips the live tests).
 */
function readApiKey(): string | null {
    let raw: string;
    try {
        raw = readFileSync(CONFIG_FILE, "utf8");
    } catch {
        return null;
    }
    const parsed = parseYaml(raw) as
        | { inference?: { customProviders?: { featherless?: { apiKey?: unknown } } } }
        | undefined;
    const key = parsed?.inference?.customProviders?.featherless?.apiKey;
    return typeof key === "string" && key.length > 0 ? key : null;
}

/** Read ids currently in the cached model list, or `[]` when absent. */
function cachedModelIds(): string[] {
    let raw: string;
    try {
        raw = readFileSync(CACHE_FILE, "utf8");
    } catch {
        return [];
    }
    const data = (JSON.parse(raw) as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
        return [];
    }
    return data
        .map((m) => (m as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string");
}

/** Classic, long-lived open-weight ids likely to stay on the account. */
const CLASSIC_CANDIDATES = [
    "mistralai/Mistral-7B-Instruct-v0.2",
    "meta-llama/Meta-Llama-3.1-8B-Instruct",
];

const apiKey = readApiKey();

describe("FeatherlessModels (live)", () => {
    it("resolves structural metadata for classic models", async (t) => {
        if (apiKey === null) {
            t.skip("featherless API key not configured");
            return;
        }
        const store = new FeatherlessModels({ cacheFile: CACHE_FILE, apiKey, log: silentLog });
        await store.refreshIfStale(ONE_DAY_MS);

        const ids = cachedModelIds();
        if (ids.length === 0) {
            t.skip("featherless model cache unavailable (offline and no cache)");
            return;
        }

        // Prefer classic ids when the account hosts them; otherwise fall
        // back to whatever the account does host so the happy path is
        // still exercised.
        const present = CLASSIC_CANDIDATES.filter((id) => ids.includes(id));
        const probes = present.length > 0 ? present : [ids[0]];

        for (const id of probes) {
            const meta = await store.getMetaData(id);
            assert.ok(meta, `metadata present for ${id}`);
            assert.equal(meta.npmPackage, "@ai-sdk/openai-compatible");
            assert.equal(meta.apiEndpoint, "https://api.featherless.ai/v1");
            assert.equal(typeof meta.contextLimit, "number");
            assert.ok((meta.contextLimit ?? 0) > 0, `positive context limit for ${id}`);
        }
    });

    it("throws ModelNotSupported for an unknown model", async (t) => {
        if (apiKey === null) {
            t.skip("featherless API key not configured");
            return;
        }
        const store = new FeatherlessModels({ cacheFile: CACHE_FILE, apiKey, log: silentLog });
        await store.refreshIfStale(ONE_DAY_MS);
        if (cachedModelIds().length === 0) {
            t.skip("featherless model cache unavailable (offline and no cache)");
            return;
        }
        await assert.rejects(
            () => store.getMetaData("definitely/not-a-real-model-xyz"),
            ModelNotSupported,
        );
    });
});

describe("featherless plugin hook", () => {
    it("returns undefined when inactive (no fetch performed)", async () => {
        // start() hasn't run, so the module singleton is unset — the
        // hook must defer (return undefined) for any provider, including
        // its own, rather than throw.
        const hook = featherlessPlugin.host?.getModelMetaData;
        assert.ok(hook, "plugin declares getModelMetaData");
        const ctx = {} as HostContext;
        assert.equal(await hook(ctx, "openai", "gpt-4o-mini"), undefined);
        assert.equal(await hook(ctx, FEATHERLESS_PROVIDER, "anything"), undefined);
    });

    it("declares the featherless provider descriptor", () => {
        const hook = featherlessPlugin.host?.getModelProviders;
        assert.ok(hook, "plugin declares getModelProviders");
        const ctx = {} as HostContext;
        const descriptors = hook(ctx);
        assert.equal(descriptors.length, 1);
        assert.deepEqual(descriptors[0], {
            key: FEATHERLESS_PROVIDER,
            npmPackage: "@ai-sdk/openai-compatible",
            apiEndpoint: "https://api.featherless.ai/v1",
        });
    });
});
