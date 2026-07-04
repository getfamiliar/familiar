/**
 * Typed accessor for the configuration the host passes into the agent
 * container. The host's `ContainerConfig` collector serializes a flat
 * `{ "<key>": value }` map (config-dotted keys for config-backed values,
 * short arbitrary keys for computed ones like `bastionUrl`) and forwards
 * it as the single `FAMILIAR_CONTAINER_CONFIG` env var. This replaces the
 * old per-knob `-e KEY=VALUE` stuffing and the hand-rolled
 * int/float/bool/JSON parsing in the former `env.ts`: JSON already carries
 * real types, so {@link PassedConfig.get} just hands the stored value back.
 *
 * Defaults are deliberately NOT baked in here — each call site applies its
 * own with `?? <default>`, keeping the default in exactly one place. A
 * required value is enforced by the caller throwing on `undefined`.
 */

/** Env var carrying the host-built flat config map (JSON). */
const CONFIG_ENV_VAR = "FAMILIAR_CONTAINER_CONFIG";

/**
 * Parse the passed-config blob from the environment. A missing, blank, or
 * unparseable value yields an empty map so every {@link PassedConfig.get}
 * returns `undefined` and call-site defaults take over rather than the
 * container failing to boot on a malformed blob.
 *
 * Deliberately un-cached: the blob is small and fixed for the container's
 * lifetime in production, while reading it fresh keeps the accessor
 * test-friendly (a test can set the env var per case) and matches the
 * "re-read per call" expectation of callers like `HandlerFile`.
 *
 * @returns The parsed flat config map (possibly empty).
 */
function load(): Record<string, unknown> {
    const raw = process.env[CONFIG_ENV_VAR];
    if (!raw || raw.trim().length === 0) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/**
 * Centralized typed getter for host-passed configuration.
 */
export const PassedConfig = {
    /**
     * Read the value stored under `key` in the passed-config blob.
     *
     * @typeParam T The expected value type. JSON preserves the host's
     *   original type, so no parsing or coercion happens here — the caller
     *   is trusted to name the right `T` for the key.
     * @param key The flat-map key (config-dotted path or computed key).
     * @returns The stored value as `T`, or `undefined` when the key is
     *   absent.
     */
    get<T>(key: string): T | undefined {
        const value = load()[key];
        return value === undefined ? undefined : (value as T);
    },
};

/**
 * Read a value that the host is contracted to always pass, throwing a
 * clear boot error when it is absent. Use this only for values with no
 * sensible container-side default (e.g. `bastionUrl`,
 * `inference.defaultModel`); everything else should read via
 * {@link PassedConfig.get} and supply its own `?? <default>`.
 *
 * @typeParam T The expected value type.
 * @param key The passed-config key.
 * @returns The value typed as `T`.
 * @throws If the key is absent from the passed config.
 */
export function requireConfig<T>(key: string): T {
    const value = PassedConfig.get<T>(key);
    if (value === undefined) {
        throw new Error(`${key} is missing from the passed container config (${CONFIG_ENV_VAR}).`);
    }
    return value;
}

/**
 * Resolve the operator's preferred IANA timezone, falling back to the
 * container's own system timezone when `core.timezone` was not passed.
 * Centralizes the fallback so the system-prompt builders agree.
 *
 * @returns A valid IANA timezone string.
 */
export function resolveTimezone(): string {
    return (
        PassedConfig.get<string>("core.timezone") ??
        Intl.DateTimeFormat().resolvedOptions().timeZone
    );
}
