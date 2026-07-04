import type { HostConfigService } from "../config/ConfigService.js";

/**
 * Collector for the flat config map the host passes into the agent
 * container. Replaces the former per-knob `-e KEY=VALUE` stuffing: the
 * caller adds the values the container needs (config-backed via
 * {@link addConfigKey}, computed via {@link addValue}), and {@link toJSON}
 * serializes them into the single `FAMILIAR_CONTAINER_CONFIG` env var that
 * the container's `PassedConfig` reads back.
 *
 * Keys are the container's lookup keys: for config-backed values that is
 * the `config.yml` dotted path (e.g. `inference.maxRetries`), so the same
 * string identifies the value on both sides; for computed values it is a
 * short arbitrary key (e.g. `bastionUrl`).
 *
 * Defaults live exclusively on the container side (`?? <default>` at the
 * read site). {@link addConfigKey} therefore omits absent keys rather than
 * substituting a default — a missing value simply lets the container's
 * default apply.
 */
export class ContainerConfig {
    private readonly config: HostConfigService;
    private readonly map: Record<string, unknown> = {};

    /**
     * @param config The host config service the blob is sourced from.
     */
    constructor(config: HostConfigService) {
        this.config = config;
    }

    /**
     * Add a `config.yml`-backed value, keyed by its dotted path. The raw
     * value is read from config and stored under the same key. Absent keys
     * are omitted so the container's call-site default applies.
     *
     * @param key The `config.yml` dotted path (also the container lookup key).
     */
    addConfigKey(key: string): void {
        const value = this.config.getValue(key);
        if (value !== undefined) {
            this.map[key] = value;
        }
    }

    /**
     * Add an arbitrary computed value under `key` (e.g. a hostname or a
     * value derived host-side from flags). Stored verbatim.
     *
     * @param key The container lookup key.
     * @param value The value to forward.
     */
    addValue(key: string, value: unknown): void {
        this.map[key] = value;
    }

    /**
     * Serialize the collected map for the `FAMILIAR_CONTAINER_CONFIG` env
     * var.
     *
     * @returns The JSON string the container parses into its config.
     */
    toJSON(): string {
        return JSON.stringify(this.map);
    }
}
