/**
 * Name-based secret detection for `config.yml` / `mcp.yml` values.
 *
 * Secrets never pass through the agent: the agent-facing config tools
 * mask them on read and refuse to write them (the user enters them via
 * `config_ask_secret` or the CLI instead). Detection is a naming
 * convention, documented in `docs/config.md`: a dotted path is secret
 * when any of its segments contains one of {@link SECRET_NAME_FRAGMENTS},
 * case-insensitively. A whole subtree under a secret segment (e.g.
 * `inference.apiKeys`) is secret, so every value below it is masked.
 */

/**
 * Substrings that mark a path segment as secret. Deliberately broad —
 * a false positive only masks a value and blocks `config_set` for it;
 * a false negative would leak a credential into the model context.
 */
export const SECRET_NAME_FRAGMENTS: readonly string[] = ["key", "token", "password", "secret"];

/** Replacement shown to the agent for a secret that has a value. */
export const MASKED_SECRET_VALUE = "***set***";

/**
 * Whether a single key segment names a secret.
 *
 * @param segment One path segment, e.g. `botToken` or `apiKeys`.
 * @returns `true` when the segment contains a secret fragment.
 */
export function isSecretKeySegment(segment: string): boolean {
    const lower = segment.toLowerCase();
    return SECRET_NAME_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * Whether a dotted config path names a secret or lies below one.
 *
 * @param key Dotted path, e.g. `telegram.botToken` or `inference.apiKeys.featherless`.
 * @returns `true` when any segment is a secret segment.
 */
export function isSecretConfigKey(key: string): boolean {
    return key.split(".").some(isSecretKeySegment);
}

/**
 * Whether an MCP env var holds a secret: flagged `is_secret` or named
 * like one (`GITHUB_TOKEN`, `API_KEY`, …).
 *
 * @param env The env entry (or its name and flag).
 * @returns `true` for a secret.
 */
export function isSecretMcpEnv(env: {
    readonly name: string;
    readonly is_secret?: unknown;
}): boolean {
    return env.is_secret === true || isSecretConfigKey(env.name);
}

/**
 * Deep-copy `value` with every secret replaced: leaves at or below a
 * secret segment become {@link MASKED_SECRET_VALUE} when set (non-empty)
 * and `null` when empty, so the agent can tell "configured" from
 * "missing" without seeing the value.
 *
 * @param value The value read at `path`.
 * @param path Dotted path of `value` (empty string for the root).
 * @returns The masked copy.
 */
export function maskSecrets(value: unknown, path: string): unknown {
    const isSecret = path.length > 0 && isSecretConfigKey(path);
    if (Array.isArray(value)) {
        return isSecret
            ? value.map((entry) => maskLeaf(entry))
            : value.map((entry) => maskSecrets(entry, path));
    }
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            out[key] = maskSecrets(child, path.length > 0 ? `${path}.${key}` : key);
        }
        return out;
    }
    return isSecret ? maskLeaf(value) : value;
}

/**
 * Mask one secret leaf.
 *
 * @param value The secret value.
 * @returns {@link MASKED_SECRET_VALUE} for a set value, `null` for an empty one.
 */
function maskLeaf(value: unknown): unknown {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    if (typeof value === "object") {
        return maskSecrets(value, "secret");
    }
    return MASKED_SECRET_VALUE;
}
