import { promises as fs } from "node:fs";
import { type Logger, type ModelMetaData, ModelNotSupported } from "@getfamiliar/shared";

/** Provider id this plugin is authoritative for (hardcoded). */
export const FEATHERLESS_PROVIDER = "featherless";

/** Account-scoped model list endpoint. Needs an `Authorization` header. */
const FEATHERLESS_MODELS_URL = "https://api.featherless.ai/v1/models";

/**
 * The Featherless edge (a WAF/CDN) answers `404 Gone.` to requests
 * carrying the default `node` user-agent, so a browser-like UA is
 * required to reach the API at all. Pinned here rather than left to
 * the runtime default.
 */
const USER_AGENT = "Mozilla/5.0 (compatible; familiar)";

/** Constants that hold for every Featherless model. */
const FEATHERLESS_API_BASE = "https://api.featherless.ai/v1";
const FEATHERLESS_NPM_PACKAGE = "@ai-sdk/openai-compatible";

/**
 * Shape of the relevant slice of one entry in the Featherless
 * `/v1/models` response. Parsing stays defensive — every field is
 * treated as possibly-absent.
 */
interface FeatherlessModelEntry {
    readonly id?: unknown;
    readonly context_length?: unknown;
    readonly max_completion_tokens?: unknown;
    readonly features?: { readonly tool_use?: unknown };
}

/**
 * Owns the on-disk cache of the account's Featherless model list and
 * answers metadata lookups from it.
 *
 * Does its own authenticated fetch (the list is account-scoped, so it
 * needs an `Authorization: Bearer` header) and atomic, replace-only-on-
 * success write — deliberately not sharing a generic cache utility with
 * the host's unauthenticated models.dev fetch.
 */
export class FeatherlessModels {
    private readonly cacheFile: string;
    private readonly apiKey: string;
    private readonly log: Logger;
    /** Parsed `id → entry` map, or `undefined` until first load/refresh. */
    private models: Map<string, FeatherlessModelEntry> | undefined;

    constructor(config: { cacheFile: string; apiKey: string; log: Logger }) {
        this.cacheFile = config.cacheFile;
        this.apiKey = config.apiKey;
        this.log = config.log;
    }

    /**
     * Fetch the account's model list and replace the on-disk cache iff
     * the download succeeds and parses as JSON. On any failure the
     * existing file and in-memory map are left untouched.
     *
     * @returns `true` when the cache was replaced, `false` otherwise.
     */
    async refresh(): Promise<boolean> {
        let text: string;
        try {
            const res = await fetch(FEATHERLESS_MODELS_URL, {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "User-Agent": USER_AGENT,
                },
            });
            if (!res.ok) {
                this.log.warn(
                    { url: FEATHERLESS_MODELS_URL, status: res.status },
                    `featherless models refresh got non-2xx ${res.status}; keeping existing cache`,
                );
                return false;
            }
            text = await res.text();
            JSON.parse(text); // validate before writing
            await this.writeAtomic(text);
        } catch (err) {
            this.log.warn(
                {
                    url: FEATHERLESS_MODELS_URL,
                    err: err instanceof Error ? err.message : String(err),
                },
                "featherless models refresh failed; keeping existing cache",
            );
            return false;
        }
        this.models = parseModels(text);
        this.log.info({ models: this.models.size }, "featherless model list refreshed");
        return true;
    }

    /**
     * Refresh only when the cache is missing or older than `maxAgeMs`.
     * Used at plugin start so a fresh-enough file is reused without a
     * network round-trip.
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
     * Resolve metadata for a Featherless model id.
     *
     * @returns The model's {@link ModelMetaData}, or `undefined` when the
     *   cache isn't available yet (key configured but no successful fetch
     *   nor cached file — defer rather than claim the model is missing).
     * @throws {@link ModelNotSupported} when the list is loaded but does
     *   not contain `model` — Featherless owns this provider, so an
     *   absent id is authoritatively unsupported.
     */
    async getMetaData(model: string): Promise<ModelMetaData | undefined> {
        const models = await this.ensureLoaded();
        if (models === undefined) {
            return undefined;
        }
        const entry = models.get(model);
        if (entry === undefined) {
            throw new ModelNotSupported(`featherless does not host model "${model}"`);
        }
        return {
            npmPackage: FEATHERLESS_NPM_PACKAGE,
            apiEndpoint: FEATHERLESS_API_BASE,
            toolCall: asBoolean(entry.features?.tool_use),
            // Featherless's model list exposes no reasoning flag.
            reasoning: undefined,
            contextLimit: asNumber(entry.context_length),
            outputLimit: asNumber(entry.max_completion_tokens),
        };
    }

    /**
     * Return the parsed model map, lazily loading it from disk on first
     * use when {@link refresh} hasn't populated it yet. A missing or
     * unparseable file yields `undefined` (callers defer).
     */
    private async ensureLoaded(): Promise<Map<string, FeatherlessModelEntry> | undefined> {
        if (this.models !== undefined) {
            return this.models;
        }
        let text: string;
        try {
            text = await fs.readFile(this.cacheFile, "utf8");
        } catch {
            return undefined;
        }
        this.models = parseModels(text);
        return this.models;
    }

    /** Write `text` to a temp file and atomically rename it into place. */
    private async writeAtomic(text: string): Promise<void> {
        const tmp = `${this.cacheFile}.tmp`;
        await fs.writeFile(tmp, text, "utf8");
        await fs.rename(tmp, this.cacheFile);
    }
}

/**
 * Parse the `{ data: [...] }` Featherless response into an `id → entry`
 * map, skipping entries without a string `id`. A malformed payload
 * yields an empty map (every lookup then throws `ModelNotSupported`,
 * which is correct — the account demonstrably hosts no such model).
 */
function parseModels(text: string): Map<string, FeatherlessModelEntry> {
    const map = new Map<string, FeatherlessModelEntry>();
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return map;
    }
    const data = (parsed as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
        return map;
    }
    for (const item of data) {
        const id = (item as FeatherlessModelEntry)?.id;
        if (typeof id === "string" && id.length > 0) {
            map.set(id, item as FeatherlessModelEntry);
        }
    }
    return map;
}

/** Return the value when it's a boolean, else `undefined`. */
function asBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

/** Return the value when it's a finite number, else `undefined`. */
function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
