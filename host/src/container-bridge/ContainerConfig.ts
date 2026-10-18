import type { HostConfigService } from "../utils/ConfigService.js";

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

    /**
     * The collected map as a fresh object, e.g. for the bastion's
     * `/container-config/` endpoint.
     *
     * @returns A shallow copy of the flat config map.
     */
    toValues(): Record<string, unknown> {
        return { ...this.map };
    }
}

/**
 * `config.yml` keys forwarded verbatim into the agent container. Their
 * defaults live container-side; absent keys are simply omitted.
 */
export const FORWARDED_CONTAINER_CONFIG_KEYS: readonly string[] = [
    "core.postgresPassword",
    "core.agentStepTimeout",
    "core.toolCallOffloadingLimit",
    "core.maxToolDescriptionChars",
    "core.toolDefinitionsContextFraction",
    "core.toolHeuristicRunWindow",
    "core.timezone",
    "inference.defaultProvider",
    "inference.defaultModel",
    "inference.aliases",
    "inference.maxRetries",
    "inference.outputFallbackPercentage",
    "inference.captureInitialMessageHistory",
    "inference.contextManagement.thresholdPercentage",
];

/** Values the daemon computes (or resolves with host-side defaults) for the container. */
export interface AgentContainerComputedValues {
    /** Bastion URL as the agent dials it (via the bridge sidecar). */
    readonly bastionUrl: string;
    /** Shared bastion token. */
    readonly bastionToken: string;
    /** Provider id → npm package of every resolved inference provider. */
    readonly providerNpmPackages: Readonly<Record<string, string>>;
    /** Container log level (`debug` / `info`). */
    readonly logLevel: string;
    /** Resolved `core.logSystemPrompt` mode. */
    readonly logSystemPrompt: string;
    /** Resolved `inference.captureRawStepResultToDatabase` (dev default applied). */
    readonly captureRawStepResultToDatabase: boolean;
    /** `core.writablePaths` with the default applied. */
    readonly writablePaths: readonly string[];
    /** `python.packages` with the default applied. */
    readonly pythonPackages: readonly string[];
}

/**
 * Build the flat config map the agent container reads through
 * `PassedConfig`. Used for the `FAMILIAR_CONTAINER_CONFIG` env var at
 * container start and, after a config reload, for the bastion's
 * `/container-config/` endpoint the container polls per agentrun.
 *
 * @param config Host config service (forwarded keys are read from it).
 * @param computed Values resolved by the daemon.
 * @returns The populated collector.
 */
export function buildAgentContainerConfig(
    config: HostConfigService,
    computed: AgentContainerComputedValues,
): ContainerConfig {
    const containerConfig = new ContainerConfig(config);
    for (const key of FORWARDED_CONTAINER_CONFIG_KEYS) {
        containerConfig.addConfigKey(key);
    }
    containerConfig.addValue("bastionUrl", computed.bastionUrl);
    containerConfig.addValue("bastionToken", computed.bastionToken);
    containerConfig.addValue("inference.providers", computed.providerNpmPackages);
    containerConfig.addValue("core.logLevel", computed.logLevel);
    containerConfig.addValue("core.logSystemPrompt", computed.logSystemPrompt);
    containerConfig.addValue(
        "inference.captureRawStepResultToDatabase",
        computed.captureRawStepResultToDatabase,
    );
    // writablePaths / python.packages carry their host-resolved value
    // (default applied) rather than the raw config read.
    containerConfig.addValue("core.writablePaths", computed.writablePaths);
    containerConfig.addValue("python.packages", computed.pythonPackages);
    return containerConfig;
}
