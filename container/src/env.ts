/**
 * Centralized env-var helpers for the container. Lets the rest of the
 * codebase access configuration without scattering raw `process.env.X`
 * reads — which makes it easy to introduce typos or skip the parsing
 * step. The host always sets these via `AgentContainer.start`, so a
 * missing required variable is a daemon misconfiguration.
 */

/**
 * Read a required env var. Throws when unset or empty so the agent
 * fails loud at boot rather than producing confusing downstream
 * errors (e.g. `INFERENCE_DEFAULT_MODEL` missing → ModelFactory
 * receives an empty string and silently dispatches to the wrong
 * provider).
 */
export function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is not set in the agent container env.`);
    }
    return value;
}

/**
 * Parse a non-negative integer env var. Returns `undefined` for
 * unset, blank, or unparseable values so the caller can chain to a
 * downstream default with `??`.
 */
export function optionalEnvInt(name: string): number | undefined {
    const raw = process.env[name];
    if (!raw || raw.trim().length === 0) {
        return undefined;
    }
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Read a boolean env var. `true` only when the value is exactly the
 * string `"true"`; everything else (unset, `"false"`, `"0"`,
 * garbage) reads as `false`. Matches the shape the host uses to
 * forward `boolean` config values via `${value}` interpolation.
 */
export function optionalEnvBool(name: string): boolean {
    return process.env[name] === "true";
}
