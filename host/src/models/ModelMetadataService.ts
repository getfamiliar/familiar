import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger, ModelMetaData, ModelProviderDescriptor } from "@getfamiliar/shared";

/** Public models.dev metadata database. Plain GET, no auth. */
const MODELS_DEV_URL = "https://models.dev/api.json";

/** Cache filename written under `tmpDir`. */
const CACHE_FILENAME = "models.json";

/**
 * Shape of the relevant slice of a models.dev provider entry. The file
 * carries more fields (`name`, `doc`, `cost`, …); we read only what
 * maps onto {@link ModelMetaData}. Parsing stays defensive — every
 * field is treated as possibly-absent.
 */
interface ModelsDevModel {
    readonly tool_call?: unknown;
    readonly reasoning?: unknown;
    readonly limit?: { readonly context?: unknown; readonly output?: unknown };
}
interface ModelsDevProvider {
    readonly npm?: unknown;
    readonly api?: unknown;
    readonly models?: Record<string, ModelsDevModel>;
}
type ModelsDevCatalogue = Record<string, ModelsDevProvider>;

/** Dependencies for {@link ModelMetadataService}. */
export interface ModelMetadataServiceConfig {
    /** Absolute host path of the project's `tmp/` dir (`boot.tmpDir`). */
    readonly tmpDir: string;
    /**
     * Fallback lookup for models the models.dev database doesn't cover —
     * wired to `PluginHost.lookupModelMetaData`. Consulted only on a
     * built-in miss.
     */
    readonly lookupPluginMeta: (
        provider: string,
        model: string,
    ) => Promise<ModelMetaData | undefined>;
    /**
     * Plugin-declared provider descriptors (via
     * `PluginHost.listModelProviders`). Consulted by
     * {@link ModelMetadataService.lookupProvider} when the models.dev
     * catalogue doesn't cover a provider key.
     */
    readonly listPluginProviders: () => readonly ModelProviderDescriptor[];
    /** Logger child for refresh + lookup lines. */
    readonly log: Logger;
}

/**
 * Host-side source of {@link ModelMetaData}, backed by the models.dev
 * database (cached on disk at `tmp/models.json`) with a plugin fallback
 * for providers models.dev doesn't cover (e.g. featherless).
 *
 * Owns its own fetch-and-cache because the models.dev source is a plain
 * unauthenticated GET — distinct from the featherless plugin, whose
 * fetch needs an account `Authorization` header, so the two
 * deliberately don't share a generic utility.
 *
 * Writes are atomic (temp file + `rename`) and only replace the cache on
 * a successful fetch + parse, so a failed refresh leaves the previous
 * good copy in place.
 */
export class ModelMetadataService {
    private readonly cacheFile: string;
    private readonly lookupPluginMeta: ModelMetadataServiceConfig["lookupPluginMeta"];
    private readonly listPluginProviders: ModelMetadataServiceConfig["listPluginProviders"];
    private readonly log: Logger;
    /** Parsed catalogue, populated by {@link refresh} or a lazy disk read. */
    private catalogue: ModelsDevCatalogue | undefined;

    constructor(config: ModelMetadataServiceConfig) {
        this.cacheFile = path.join(config.tmpDir, CACHE_FILENAME);
        this.lookupPluginMeta = config.lookupPluginMeta;
        this.listPluginProviders = config.listPluginProviders;
        this.log = config.log;
    }

    /**
     * Fetch models.dev and replace the on-disk cache iff the download
     * succeeds and parses as JSON. On any failure the existing file is
     * left untouched and the in-memory catalogue keeps its prior value.
     *
     * @returns `true` when the cache was replaced, `false` otherwise.
     */
    async refresh(): Promise<boolean> {
        let parsed: unknown;
        try {
            const res = await fetch(MODELS_DEV_URL);
            if (!res.ok) {
                this.log.warn(
                    { url: MODELS_DEV_URL, status: res.status },
                    `models.dev refresh got non-2xx ${res.status}; keeping existing ${this.cacheFile}`,
                );
                return false;
            }
            const text = await res.text();
            parsed = JSON.parse(text);
            await this.writeAtomic(text);
        } catch (err) {
            this.log.warn(
                { url: MODELS_DEV_URL, err: err instanceof Error ? err.message : String(err) },
                `models.dev refresh failed; keeping existing ${this.cacheFile}`,
            );
            return false;
        }
        this.catalogue = asCatalogue(parsed);
        this.log.info(
            { providers: Object.keys(this.catalogue).length, file: this.cacheFile },
            "models.dev catalogue refreshed",
        );
        return true;
    }

    /**
     * Refresh only when the cache is missing or older than `maxAgeMs`.
     * Used at daemon start so a fresh-enough file (e.g. updated earlier
     * today) is reused without a network round-trip.
     */
    async refreshIfStale(maxAgeMs: number): Promise<void> {
        let ageMs: number;
        try {
            const stat = await fs.stat(this.cacheFile);
            ageMs = Date.now() - stat.mtimeMs;
        } catch {
            ageMs = Number.POSITIVE_INFINITY;
        }
        if (ageMs > maxAgeMs) {
            await this.refresh();
        }
    }

    /**
     * Resolve metadata for a `(provider, model)` pair. Checks the
     * models.dev catalogue first; on a miss, delegates to the plugin
     * fallback. Returns `undefined` when neither source knows the model.
     *
     * @param provider Resolved provider id (e.g. `deepseek`, `featherless`).
     * @param model Resolved model id.
     */
    async lookup(provider: string, model: string): Promise<ModelMetaData | undefined> {
        const catalogue = await this.ensureCatalogue();
        const providerEntry = catalogue[provider];
        const modelEntry = providerEntry?.models?.[model];
        if (providerEntry !== undefined && modelEntry !== undefined) {
            return {
                npmPackage: asString(providerEntry.npm),
                apiEndpoint: asString(providerEntry.api),
                toolCall: asBoolean(modelEntry.tool_call),
                reasoning: asBoolean(modelEntry.reasoning),
                contextLimit: asNumber(modelEntry.limit?.context),
                outputLimit: asNumber(modelEntry.limit?.output),
            };
        }
        return this.lookupPluginMeta(provider, model);
    }

    /**
     * Resolve **provider-level** metadata (`npmPackage` + optional
     * `apiEndpoint`) for a provider key — independent of any specific
     * model. Backs provider resolution (reverse-proxy auth/base,
     * container `create*` selection, `ctx.inference.resolveProvider`).
     *
     * models.dev catalogue first (`catalogue[key].npm` / `.api`); on a
     * miss, the first plugin descriptor whose `key` matches. Returns
     * `undefined` when neither source knows the provider.
     *
     * @param key Provider key as used under `inference.apiKeys.<key>`.
     */
    async lookupProvider(
        key: string,
    ): Promise<{ npmPackage?: string; apiEndpoint?: string } | undefined> {
        const catalogue = await this.ensureCatalogue();
        const providerEntry = catalogue[key];
        if (providerEntry !== undefined && asString(providerEntry.npm) !== undefined) {
            return {
                npmPackage: asString(providerEntry.npm),
                apiEndpoint: asString(providerEntry.api),
            };
        }
        const descriptor = this.listPluginProviders().find((d) => d.key === key);
        if (descriptor !== undefined) {
            return { npmPackage: descriptor.npmPackage, apiEndpoint: descriptor.apiEndpoint };
        }
        return undefined;
    }

    /**
     * Return the parsed catalogue, lazily loading it from disk on first
     * use when {@link refresh} hasn't populated it yet. A missing or
     * unparseable file yields an empty catalogue (every lookup then
     * falls through to the plugin path).
     */
    private async ensureCatalogue(): Promise<ModelsDevCatalogue> {
        if (this.catalogue !== undefined) {
            return this.catalogue;
        }
        try {
            const text = await fs.readFile(this.cacheFile, "utf8");
            this.catalogue = asCatalogue(JSON.parse(text));
        } catch (err) {
            this.log.warn(
                { file: this.cacheFile, err: err instanceof Error ? err.message : String(err) },
                "models.dev cache unreadable; using empty catalogue until next refresh",
            );
            this.catalogue = {};
        }
        return this.catalogue;
    }

    /** Write `text` to a temp file and atomically rename it into place. */
    private async writeAtomic(text: string): Promise<void> {
        const tmp = `${this.cacheFile}.tmp`;
        await fs.writeFile(tmp, text, "utf8");
        await fs.rename(tmp, this.cacheFile);
    }
}

/** Narrow an arbitrary parsed value to a catalogue mapping. */
function asCatalogue(value: unknown): ModelsDevCatalogue {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value as ModelsDevCatalogue;
}

/** Return the value when it's a string, else `undefined`. */
function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** Return the value when it's a boolean, else `undefined`. */
function asBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

/** Return the value when it's a finite number, else `undefined`. */
function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
