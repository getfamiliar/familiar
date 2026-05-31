import path from "node:path";
import { definePlugin, type HostContext, type ModelMetaData } from "@getfamiliar/shared";
import {
    FEATHERLESS_PROVIDER,
    FEATHERLESS_PROVIDER_DESCRIPTOR,
    FeatherlessModels,
} from "./FeatherlessModels.js";

/** Cache filename written under `ctx.tmpDir`. */
const CACHE_FILENAME = "models.featherless.json";

/**
 * Config path of the Featherless API key. The provider key is hardcoded
 * to `featherless`, so the key lives under `inference.apiKeys.featherless`
 * like every other provider (the provider's npm package + endpoint come
 * from this plugin's `getModelProviders` descriptor, not from config).
 */
const API_KEY_CONFIG = "inference.apiKeys.featherless";

/** 24 hours in milliseconds — refresh cadence + staleness window. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Module-scoped state shared between the `start`/`stop` lifecycle and
 * the `getModelMetaData` hook. Set in `start` when the Featherless API
 * key is configured; left `undefined` otherwise (the plugin is then
 * inert — `getModelMetaData` returns `undefined` for everything).
 */
let store: FeatherlessModels | undefined;
let refreshTimer: NodeJS.Timeout | undefined;

/**
 * Featherless host-side plugin.
 *
 * Supplies {@link ModelMetaData} for Featherless-hosted models — the
 * provider models.dev doesn't cover. It keeps an account-scoped copy of
 * `https://api.featherless.ai/v1/models` cached at
 * `tmp/models.featherless.json` (refreshed on start when stale and every
 * 24 h thereafter) and answers the host's `getModelMetaData` lookups
 * from it.
 *
 * The plugin self-disables (no fetch, no timer, lookups return
 * `undefined`) when the Featherless API key is unset.
 */
export default definePlugin({
    id: "featherless",
    host: {
        start: async (ctx) => {
            const apiKey = ctx.config.getString(API_KEY_CONFIG, null);
            if (apiKey === null || apiKey.length === 0) {
                ctx.logger.info("featherless API key unset; plugin inactive");
                return;
            }
            store = new FeatherlessModels({
                cacheFile: path.join(ctx.tmpDir, CACHE_FILENAME),
                apiKey,
                log: ctx.logger,
            });
            await store.refreshIfStale(ONE_DAY_MS);
            refreshTimer = setInterval(() => {
                void store?.refresh();
            }, ONE_DAY_MS);
            // Don't keep the event loop alive on the daily timer alone.
            refreshTimer.unref();
        },
        stop: async () => {
            if (refreshTimer !== undefined) {
                clearInterval(refreshTimer);
                refreshTimer = undefined;
            }
            store = undefined;
        },
        getModelProviders: () => [FEATHERLESS_PROVIDER_DESCRIPTOR],
        getModelMetaData: async (
            _ctx: HostContext,
            provider: string,
            model: string,
        ): Promise<ModelMetaData | undefined> => {
            if (provider !== FEATHERLESS_PROVIDER || store === undefined) {
                return undefined;
            }
            return store.getMetaData(model);
        },
    },
});
