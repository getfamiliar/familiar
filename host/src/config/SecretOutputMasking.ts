import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { isSecretConfigKey, isSecretMcpEnv } from "./SecretKeys.js";

/**
 * Masking of configured secret *values* in free-form command output.
 *
 * {@link maskSecrets} (`SecretKeys.ts`) masks by key, which works for
 * structured config. Output of a command run on the agent's behalf
 * (`mcp_execute_bash_command`) has no keys, so here every secret value
 * from `config.yml` and `mcp.yml` is searched for literally and
 * replaced by {@link MASKED_OUTPUT_SECRET}.
 */

/** Replacement for a secret value found in command output. */
export const MASKED_OUTPUT_SECRET = "***";

/**
 * Secret values shorter than this are not masked: they would replace
 * ordinary words or digits all over the output, and no real
 * credential is that short.
 */
export const MIN_MASKED_SECRET_LENGTH = 4;

/**
 * Collect every secret value configured in `config.yml` (leaves at or
 * below a secret path, see `isSecretConfigKey`) and `mcp.yml` (secret
 * env values of all entries, see `isSecretMcpEnv`). Reads both files
 * fresh, so a secret the user has just entered is covered. Missing
 * files contribute nothing.
 *
 * @param configFile Absolute path of `config.yml`.
 * @param mcpConfigFile Absolute path of `mcp.yml`.
 * @returns The distinct secret values with at least {@link MIN_MASKED_SECRET_LENGTH} characters.
 * @throws Error when a file exists but does not parse — the caller must not release unmasked output then.
 */
export function collectConfiguredSecrets(configFile: string, mcpConfigFile: string): string[] {
    const secrets = new Set<string>();
    collectConfigLeaves(readYaml(configFile), "", false, secrets);
    const mcpRoot = readYaml(mcpConfigFile);
    if (mcpRoot !== null && typeof mcpRoot === "object" && !Array.isArray(mcpRoot)) {
        for (const entry of Object.values(mcpRoot as Record<string, unknown>)) {
            const envItems = (entry as { env?: unknown } | null)?.env;
            if (!Array.isArray(envItems)) {
                continue;
            }
            for (const item of envItems) {
                const env = item as { name?: unknown; value?: unknown; is_secret?: unknown } | null;
                if (
                    typeof env?.name !== "string" ||
                    !isSecretMcpEnv({ name: env.name, is_secret: env.is_secret })
                ) {
                    continue;
                }
                addSecret(env.value, secrets);
            }
        }
    }
    return [...secrets];
}

/**
 * Mask every occurrence of the secrets in `text`.
 *
 * @param text Output to mask.
 * @param secrets Secret values (see {@link collectConfiguredSecrets}).
 * @returns The masked text.
 */
export function maskSecretValues(text: string, secrets: readonly string[]): string {
    return maskSecretSlice(text, 0, true, secrets).text;
}

/** Result of {@link maskSecretSlice}. */
export interface MaskedSlice {
    /** The masked text of `raw[from, end)`. */
    readonly text: string;
    /** Index in `raw` up to which the slice was consumed. */
    readonly end: number;
}

/**
 * Mask the part of a growing output buffer that can safely be released.
 * While more output may follow (`isComplete: false`), the tail that could
 * still be the beginning of a secret is held back: everything from
 * `raw.length - (longest pattern - 1)` on stays for the next call, unless
 * a complete match started before that point (then `end` moves past it).
 * Consecutive calls with `from` = the previous `end` therefore never
 * release a secret split across two reads.
 *
 * @param raw The unmasked buffer.
 * @param from Index of the first character not yet released.
 * @param isComplete Whether `raw` is final (the process has exited).
 * @param secrets Secret values (see {@link collectConfiguredSecrets}).
 * @returns The masked text and the index to continue from.
 */
export function maskSecretSlice(
    raw: string,
    from: number,
    isComplete: boolean,
    secrets: readonly string[],
): MaskedSlice {
    const patterns = secretPatterns(secrets);
    const longest = patterns.length > 0 ? patterns[0].length : 1;
    const limit = isComplete ? raw.length : Math.max(from, raw.length - (longest - 1));
    if (patterns.length === 0) {
        return { text: raw.slice(from, limit), end: limit };
    }
    // Alternatives are tried left to right at each position, so the
    // longest-first order masks a secret containing another one whole.
    const matcher = new RegExp(patterns.map(escapeRegExp).join("|"), "g");
    matcher.lastIndex = from;
    let text = "";
    let position = from;
    for (let match = matcher.exec(raw); match !== null; match = matcher.exec(raw)) {
        if (match.index >= limit) {
            break;
        }
        text += raw.slice(position, match.index) + MASKED_OUTPUT_SECRET;
        position = match.index + match[0].length;
    }
    if (position < limit) {
        text += raw.slice(position, limit);
        position = limit;
    }
    return { text, end: position };
}

/**
 * Expand secret values to the literal strings searched for: the value
 * itself plus its URL-encoded and JSON-escaped forms, longest first.
 *
 * @param secrets Secret values.
 * @returns Distinct non-empty patterns, longest first.
 */
function secretPatterns(secrets: readonly string[]): string[] {
    const patterns = new Set<string>();
    for (const secret of secrets) {
        if (secret.length < MIN_MASKED_SECRET_LENGTH) {
            continue;
        }
        patterns.add(secret);
        patterns.add(encodeURIComponent(secret));
        patterns.add(JSON.stringify(secret).slice(1, -1));
    }
    return [...patterns].sort((a, b) => b.length - a.length);
}

/**
 * Walk a parsed `config.yml` subtree and add every scalar leaf at or
 * below a secret path.
 *
 * @param value The subtree.
 * @param path Dotted path of `value` (empty for the root).
 * @param isUnderSecret Whether an ancestor path is already secret.
 * @param secrets Collector.
 */
function collectConfigLeaves(
    value: unknown,
    path: string,
    isUnderSecret: boolean,
    secrets: Set<string>,
): void {
    const isSecret = isUnderSecret || (path.length > 0 && isSecretConfigKey(path));
    if (Array.isArray(value)) {
        for (const item of value) {
            collectConfigLeaves(item, path, isSecret, secrets);
        }
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            collectConfigLeaves(child, path.length > 0 ? `${path}.${key}` : key, isSecret, secrets);
        }
        return;
    }
    if (isSecret) {
        addSecret(value, secrets);
    }
}

/**
 * Add a scalar secret value when it is long enough to mask.
 *
 * @param value The configured value.
 * @param secrets Collector.
 */
function addSecret(value: unknown, secrets: Set<string>): void {
    if (typeof value !== "string" && typeof value !== "number") {
        return;
    }
    const text = String(value);
    if (text.length >= MIN_MASKED_SECRET_LENGTH) {
        secrets.add(text);
    }
}

/**
 * Parse a YAML file; a missing file reads as `null`.
 *
 * @param filePath Absolute path.
 * @returns The parsed document.
 * @throws Error when the file exists but does not parse.
 */
function readYaml(filePath: string): unknown {
    if (!existsSync(filePath)) {
        return null;
    }
    try {
        return parse(readFileSync(filePath, "utf-8"));
    } catch (err) {
        throw new Error(
            `${filePath} does not parse, so its secrets cannot be masked: ${(err as Error).message}`,
        );
    }
}

/**
 * Escape a literal for use inside a regular expression.
 *
 * @param literal The literal text.
 * @returns The escaped pattern.
 */
function escapeRegExp(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
