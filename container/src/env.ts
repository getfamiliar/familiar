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

/**
 * Workspace-relative glob patterns the operator marked as
 * `core.writablePaths`: paths a non-privileged agentrun may write
 * (bypassing the `.md` / `toolgroups/` privilege gate) and that the
 * memory plugin quotes in full. The host forwards the normalized list
 * as `CORE_WRITABLE_PATHS` (a JSON array of strings). Returns `[]` on
 * unset, blank, or unparseable input so the privilege gate falls back
 * to its strict default rather than throwing at boot.
 */
export function getWritablePaths(): string[] {
    const raw = process.env.CORE_WRITABLE_PATHS;
    if (!raw || raw.trim().length === 0) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter(
            (entry): entry is string => typeof entry === "string" && entry.length > 0,
        );
    } catch {
        return [];
    }
}

/**
 * Resolve the user's preferred IANA timezone. The host forwards
 * `core.timezone` (validated at lint time) as `CORE_TIMEZONE`; when
 * unset or blank we fall back to whatever
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` reports for the
 * container's system tz. Used by the system-prompt builder to give
 * the agent a wall-clock view of "now" with weekday and zone label.
 */
export function getCoreTimezone(): string {
    const fromEnv = process.env.CORE_TIMEZONE;
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
        return fromEnv;
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
